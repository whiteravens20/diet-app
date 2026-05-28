/**
 * F14 auto-translate background job runner.
 *
 * Mirrors the SeedRunner pattern (single-flight, in-memory state, polled by
 * the admin panel via GET /api/admin/translations/fill/status). Calls the
 * admin-default AI provider configured via AI_DEFAULT_PROVIDER /
 * AI_DEFAULT_MODEL env vars — does NOT consult per-user AI keys or the DB,
 * because translation is an instance-level operator action.
 *
 * Scope semantics:
 *   - missing — fill only rows that have no translation in the target locale
 *   - ai      — re-translate existing AI rows (post model upgrade)
 *   - all     — overwrite everything except CURATED_JSON (which is git's job)
 *
 * The runner never touches CURATED_JSON rows — those are owned by the seeder.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TranslationSource } from '@prisma/client';
import { NON_CANONICAL_LOCALES, type Locale } from '@diet-app/shared';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AnthropicProvider } from '../../ai/providers/anthropic.provider.js';
import { OllamaProvider } from '../../ai/providers/ollama.provider.js';
import { OpenAiProvider } from '../../ai/providers/openai.provider.js';
import { OpenRouterProvider } from '../../ai/providers/openrouter.provider.js';
import type { AiProviderAdapter } from '../../ai/provider.interface.js';
import { PROVIDER_TUNING, buildPrompt } from './prompt.js';
import { validate, type ValidationReason } from './validate.js';

export type TranslateScope = 'missing' | 'ai' | 'all';
export type TranslateStatus = 'idle' | 'running' | 'done' | 'error';

export interface TranslateRunnerState {
  status: TranslateStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Locales queued for this run (length 1 for single-locale, N for `locale=all`). */
  localesQueued: Locale[];
  /** Locales the runner has already completed. */
  localesDone: Locale[];
  /** The locale currently being processed, if any. */
  currentLocale: Locale | null;
  /** Determinate progress for the current locale: rows attempted / total. */
  processed: number;
  total: number;
  /** Rows skipped after two retries failed validation. */
  failed: number;
  /** Aggregate counters across the whole run. */
  totals: { processed: number; failed: number; written: number };
  /** Provider chip the UI shows beside the progress bar. */
  provider: string | null;
  model: string | null;
  error: string | null;
}

/** What the runner writes about each batch of failures — useful for logs. */
interface FailureSample {
  key: string;
  reason: ValidationReason;
}

@Injectable()
export class TranslateRunner {
  private readonly logger = new Logger(TranslateRunner.name);
  private state: TranslateRunnerState = TranslateRunner.idle();
  /** Flipped by {@link cancel}; the run loop checks it after each batch. */
  private cancelRequested = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly openai: OpenAiProvider,
    private readonly anthropic: AnthropicProvider,
    private readonly openrouter: OpenRouterProvider,
    private readonly ollama: OllamaProvider,
  ) {}

  /**
   * Co-operative cancel: the run loop checks the flag after each batch and
   * finalises the state as `done` with `error: 'cancelled'`. No-op when no
   * job is running. Returns true if a job was actually cancelled.
   */
  cancel(): boolean {
    if (this.state.status !== 'running') return false;
    this.cancelRequested = true;
    return true;
  }

  /**
   * Delete every AI-sourced translation row across all locales. Used as a
   * "the model produced garbage, start over" button. Refuses to run while a
   * translation job is in flight so we never delete rows the runner is
   * concurrently writing.
   */
  async wipeAi(): Promise<{ ingredients: number; recipes: number }> {
    if (this.state.status === 'running') {
      throw new Error('cannot wipe AI rows while a translation job is running');
    }
    const [ing, rec] = await this.prisma.$transaction([
      this.prisma.ingredientTranslation.deleteMany({ where: { source: 'AI' } }),
      this.prisma.recipeTranslation.deleteMany({ where: { source: 'AI' } }),
    ]);
    this.logger.log(`Wiped AI translations: ${ing.count} ingredients, ${rec.count} recipes`);
    return { ingredients: ing.count, recipes: rec.count };
  }

  getState(): TranslateRunnerState {
    return this.state;
  }

  /** AI_DEFAULT_PROVIDER + AI_DEFAULT_MODEL together unlock the admin
   *  auto-translate button. Either missing = action disabled. */
  isConfigured(): boolean {
    return Boolean(
      this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) &&
        this.config.get('AI_DEFAULT_MODEL', { infer: true }),
    );
  }

  /**
   * Kick off a translate job. `locale = 'all'` fans out to every non-canonical
   * locale in sequence. Returns false if a job is already running so the
   * caller can answer 409.
   */
  start(locale: 'all' | Locale, scope: TranslateScope): boolean {
    if (this.state.status === 'running') return false;
    if (!this.isConfigured()) {
      this.state = {
        ...TranslateRunner.idle(),
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: 'AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL not configured',
      };
      return true;
    }
    const queued: Locale[] = locale === 'all' ? [...NON_CANONICAL_LOCALES] : [locale];
    const provider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) ?? null;
    const model = this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null;
    this.cancelRequested = false;

    this.state = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      localesQueued: queued,
      localesDone: [],
      currentLocale: null,
      processed: 0,
      total: 0,
      failed: 0,
      totals: { processed: 0, failed: 0, written: 0 },
      provider,
      model,
      error: null,
    };

    void this.run(scope);
    return true;
  }

  private async run(scope: TranslateScope): Promise<void> {
    try {
      for (const locale of this.state.localesQueued) {
        if (this.cancelRequested) break;
        this.state = {
          ...this.state,
          currentLocale: locale,
          processed: 0,
          total: 0,
          failed: 0,
        };
        await this.fillLocale(locale, scope);
        if (this.cancelRequested) break;
        this.state = {
          ...this.state,
          localesDone: [...this.state.localesDone, locale],
        };
      }
      this.state = {
        ...this.state,
        status: 'done',
        currentLocale: null,
        finishedAt: new Date().toISOString(),
        error: this.cancelRequested ? 'cancelled' : null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Translate run failed: ${message}`);
      this.state = {
        ...this.state,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: message,
      };
    }
  }

  private async fillLocale(locale: Locale, scope: TranslateScope): Promise<void> {
    // Pull every ingredient/recipe plus a flat list of existing translation
    // rows for this locale, then decide row-by-row what to do.
    const [ingredients, ingTrans, recipes, recTrans] = await Promise.all([
      this.prisma.ingredient.findMany({
        select: { id: true, slug: true, name: true, storageHint: true },
      }),
      this.prisma.ingredientTranslation.findMany({
        where: { locale },
        select: { ingredientId: true, source: true },
      }),
      this.prisma.recipe.findMany({
        where: { origin: 'seed' },
        select: { id: true, slug: true, title: true, description: true, steps: true },
      }),
      this.prisma.recipeTranslation.findMany({
        where: { locale },
        select: { recipeId: true, source: true },
      }),
    ]);
    const ingExisting = new Map(ingTrans.map((t) => [t.ingredientId, t.source]));
    const recExisting = new Map(recTrans.map((t) => [t.recipeId, t.source]));

    const ingredientTargets = ingredients.filter((i) =>
      shouldTranslate(ingExisting.get(i.id), scope),
    );
    const recipeTargets = recipes.filter((r) =>
      shouldTranslate(recExisting.get(r.id), scope),
    );

    this.state = {
      ...this.state,
      total: ingredientTargets.length + recipeTargets.length,
    };

    const adapter = this.pickAdapter();
    const tuning = PROVIDER_TUNING[adapter.kind];

    // Ingredient batch: 2 keys per row (name + storageHint). We pack
    // multiple rows per LLM call to keep terminology stable across siblings.
    for (let i = 0; i < ingredientTargets.length; i += tuning.batchSize) {
      if (this.cancelRequested) return;
      const batch = ingredientTargets.slice(i, i + tuning.batchSize);
      const source: Record<string, string> = {};
      for (const ing of batch) {
        source[`${ing.id}.name`] = ing.name;
        if (ing.storageHint) source[`${ing.id}.storageHint`] = ing.storageHint;
      }
      const translations = await this.translateBatch(adapter, source, locale, tuning.temperature);
      for (const ing of batch) {
        const name = translations[`${ing.id}.name`];
        if (!name) {
          this.markFailed();
          continue;
        }
        const storageHint = translations[`${ing.id}.storageHint`] ?? null;
        await this.prisma.ingredientTranslation.upsert({
          where: { ingredientId_locale: { ingredientId: ing.id, locale } },
          create: { ingredientId: ing.id, locale, name, storageHint, source: 'AI' },
          update: { name, storageHint, source: 'AI' },
        });
        this.markWritten();
      }
      if (tuning.interBatchDelayMs > 0 && i + tuning.batchSize < ingredientTargets.length) {
        await this.cancellableSleep(tuning.interBatchDelayMs);
      }
    }

    // Recipe batch: title + description go in one call; steps go in a
    // second pass because each step is its own JSON value (avoids array
    // serialisation tripping up smaller models).
    for (let i = 0; i < recipeTargets.length; i += tuning.batchSize) {
      if (this.cancelRequested) return;
      const batch = recipeTargets.slice(i, i + tuning.batchSize);
      const titleSource: Record<string, string> = {};
      for (const r of batch) {
        titleSource[`${r.id}.title`] = r.title;
        titleSource[`${r.id}.description`] = r.description;
      }
      const titleOut = await this.translateBatch(adapter, titleSource, locale, tuning.temperature);

      for (const r of batch) {
        const title = titleOut[`${r.id}.title`];
        const description = titleOut[`${r.id}.description`];
        if (!title || !description) {
          this.markFailed();
          continue;
        }
        let steps: string[] = [];
        if (r.steps.length > 0) {
          const stepsSource: Record<string, string> = {};
          r.steps.forEach((s, idx) => {
            stepsSource[String(idx)] = s;
          });
          const stepsOut = await this.translateBatch(
            adapter,
            stepsSource,
            locale,
            tuning.temperature,
          );
          steps = r.steps.map((_, idx) => stepsOut[String(idx)] ?? r.steps[idx]);
        }
        await this.prisma.recipeTranslation.upsert({
          where: { recipeId_locale: { recipeId: r.id, locale } },
          create: { recipeId: r.id, locale, title, description, steps, source: 'AI' },
          update: { title, description, steps, source: 'AI' },
        });
        this.markWritten();
      }
      if (tuning.interBatchDelayMs > 0 && i + tuning.batchSize < recipeTargets.length) {
        await this.cancellableSleep(tuning.interBatchDelayMs);
      }
    }
  }

  /** Single batch call: build the prompt, call the LLM, validate, retry once
   *  with a stricter reminder, give up after that (skip individual keys). */
  private async translateBatch(
    adapter: AiProviderAdapter,
    source: Record<string, string>,
    locale: Locale,
    temperature: number,
  ): Promise<Record<string, string>> {
    if (Object.keys(source).length === 0) return {};
    const failures: FailureSample[] = [];
    // 3 attempts (was 2): gemini-2.5-flash-lite intermittently returns
    // empty `{"` responses; the extra retry recovers ~half of those that
    // the 2-attempt loop would have given up on.
    for (const attempt of [0, 1, 2]) {
      try {
        const reminder = attempt === 0
          ? ''
          : '\nReminder: respond with ONLY the COMPLETE JSON object. No prose, no fences, no notes. Do not truncate.';
        const prompt = buildPrompt({ targetLocale: locale, source }) + reminder;
        const result = await this.callWithBackoff(() =>
          adapter.chat(
            [{ role: 'user', content: prompt }],
            {
              model: this.config.get('AI_DEFAULT_MODEL', { infer: true })!,
              apiKey: this.adapterKey(adapter),
              baseUrl: this.adapterBaseUrl(adapter),
              temperature,
              json: true,
            },
          ),
        );
        const v = validate({ source, targetLocale: locale, rawOutput: result.text });
        if (v.ok && v.translations) return v.translations;
        if (!v.ok && v.reason) {
          failures.push({ key: v.key ?? '?', reason: v.reason });
          // Capture the head + tail of the raw output so we can tell apart
          // truncation (no closing brace), refusal text, prose wrapping, etc.
          const head = result.text.slice(0, 200).replace(/\s+/g, ' ');
          const tail = result.text.slice(-200).replace(/\s+/g, ' ');
          this.logger.warn(
            `validate fail (${v.reason}): len=${result.text.length} head="${head}" tail="${tail}"`,
          );
        }
      } catch (err) {
        this.logger.warn(`translate batch error: ${describe(err)}`);
      }
    }
    if (failures.length > 0) {
      this.logger.warn(
        `translate batch rejected after 2 attempts: ${failures
          .map((f) => `${f.key}=${f.reason}`)
          .join(', ')}`,
      );
    }
    // Skip this batch — markFailed is the caller's responsibility per-row.
    return {};
  }

  /** Wraps the LLM call with 429-aware exponential backoff. Free-tier
   *  providers (OpenRouter especially) throttle aggressively per minute, so
   *  we sleep and retry rather than counting the 429 as a real failure. Up
   *  to 4 backoff attempts with 30→60→120→240s sleeps. After that gives up
   *  and lets the caller's existing 2-attempt retry kick in. */
  private async callWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    const sleeps = [30_000, 60_000, 120_000, 240_000];
    let lastErr: unknown;
    for (let i = 0; i <= sleeps.length; i++) {
      if (this.cancelRequested) throw new Error('cancelled');
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/429|rate.?limit|too many/i.test(msg) || i === sleeps.length) throw err;
        const wait = sleeps[i];
        this.logger.warn(`429 rate-limited, sleeping ${wait / 1000}s before retry…`);
        await this.cancellableSleep(wait);
        if (this.cancelRequested) throw new Error('cancelled');
      }
    }
    throw lastErr;
  }

  /** Sleep up to `ms` milliseconds, but wake early (and return) the moment
   *  `cancelRequested` flips. Polls the flag every 500 ms — quick enough
   *  that a Stop click is felt within half a second even mid-backoff. */
  private async cancellableSleep(ms: number): Promise<void> {
    const slice = 500;
    let elapsed = 0;
    while (elapsed < ms && !this.cancelRequested) {
      await new Promise((r) => setTimeout(r, Math.min(slice, ms - elapsed)));
      elapsed += slice;
    }
  }

  private markWritten(): void {
    this.state = {
      ...this.state,
      processed: this.state.processed + 1,
      totals: {
        ...this.state.totals,
        processed: this.state.totals.processed + 1,
        written: this.state.totals.written + 1,
      },
    };
  }

  private markFailed(): void {
    this.state = {
      ...this.state,
      processed: this.state.processed + 1,
      failed: this.state.failed + 1,
      totals: {
        ...this.state.totals,
        processed: this.state.totals.processed + 1,
        failed: this.state.totals.failed + 1,
      },
    };
  }

  private pickAdapter(): AiProviderAdapter {
    const provider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true });
    switch (provider) {
      case 'openai':
        return this.openai;
      case 'anthropic':
        return this.anthropic;
      case 'openrouter':
        return this.openrouter;
      case 'ollama':
        return this.ollama;
      default:
        throw new Error(`unknown AI_DEFAULT_PROVIDER: ${String(provider)}`);
    }
  }

  private adapterKey(adapter: AiProviderAdapter): string | undefined {
    // Direct env keys only — admin auto-translate is operator-scoped.
    switch (adapter.kind) {
      case 'openai':
        return process.env.OPENAI_API_KEY;
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY;
      case 'openrouter':
        return process.env.OPENROUTER_API_KEY;
      case 'ollama':
        return undefined;
    }
  }

  private adapterBaseUrl(adapter: AiProviderAdapter): string | undefined {
    return adapter.kind === 'ollama'
      ? this.config.get('OLLAMA_BASE_URL', { infer: true })
      : undefined;
  }

  private static idle(): TranslateRunnerState {
    return {
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      localesQueued: [],
      localesDone: [],
      currentLocale: null,
      processed: 0,
      total: 0,
      failed: 0,
      totals: { processed: 0, failed: 0, written: 0 },
      provider: null,
      model: null,
      error: null,
    };
  }
}

/** Should this row be (re)translated under the given scope? */
function shouldTranslate(
  existingSource: TranslationSource | undefined,
  scope: TranslateScope,
): boolean {
  if (!existingSource) return scope !== 'ai'; // missing — fill on missing | all
  if (existingSource === 'CURATED_JSON') return false; // never touched
  if (existingSource === 'AI') return scope === 'ai' || scope === 'all';
  if (existingSource === 'MANUAL') return scope === 'all';
  return false;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
