/**
 * Ingredient-namer draft runner.
 *
 * Single-flight job that walks USDA-imported ingredients lacking a current
 * draft and asks the admin-default AI provider to propose friendly culinary
 * names per `targetLocales`. Drafts land in `IngredientNameDraft` as PENDING;
 * the live `Ingredient` table is never touched (see ADR-0008).
 *
 * Mirrors `apps/api/src/admin/translate/runner.ts` for the cancel + state
 * shape so the admin panel can poll one consistent payload.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { NON_CANONICAL_LOCALES, type Locale } from '@diet-app/shared';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AnthropicProvider } from '../../ai/providers/anthropic.provider.js';
import { OllamaProvider } from '../../ai/providers/ollama.provider.js';
import { OpenAiProvider } from '../../ai/providers/openai.provider.js';
import { OpenRouterProvider } from '../../ai/providers/openrouter.provider.js';
import type { AiProviderAdapter } from '../../ai/provider.interface.js';
import { PROVIDER_TUNING } from '../translate/prompt.js';
import {
  INGREDIENT_NAMER_PROMPT_VERSION,
  buildIngredientNamerPrompt,
} from './ingredient-namer.prompt.js';
import {
  validateIngredientNamer,
  type IngredientNamerValidationReason,
} from './ingredient-namer.validate.js';

export type IngredientNamerScope = 'all-usda-missing' | 'specific-slugs';

export type DraftRunnerStatus = 'idle' | 'running' | 'done' | 'error';

export interface IngredientNamerRunnerState {
  status: DraftRunnerStatus;
  startedAt: string | null;
  finishedAt: string | null;
  processed: number;
  total: number;
  failed: number;
  written: number;
  provider: string | null;
  model: string | null;
  /** Set when a run kicks off so the UI can deep-link to the new drafts. */
  batchId: string | null;
  error: string | null;
}

export interface IngredientNamerStartSpec {
  scope: IngredientNamerScope;
  slugs?: string[];
  targetLocales?: Locale[];
}

@Injectable()
export class IngredientNamerRunner {
  private readonly logger = new Logger(IngredientNamerRunner.name);
  private state: IngredientNamerRunnerState = IngredientNamerRunner.idle();
  private cancelRequested = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly openai: OpenAiProvider,
    private readonly anthropic: AnthropicProvider,
    private readonly openrouter: OpenRouterProvider,
    private readonly ollama: OllamaProvider,
  ) {}

  cancel(): boolean {
    if (this.state.status !== 'running') return false;
    this.cancelRequested = true;
    return true;
  }

  getState(): IngredientNamerRunnerState {
    return this.state;
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) &&
        this.config.get('AI_DEFAULT_MODEL', { infer: true }),
    );
  }

  start(spec: IngredientNamerStartSpec): boolean {
    if (this.state.status === 'running') return false;
    if (!this.isConfigured()) {
      this.state = {
        ...IngredientNamerRunner.idle(),
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: 'AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL not configured',
      };
      return true;
    }
    const provider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) ?? null;
    const model = this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null;
    const batchId = `ing-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.cancelRequested = false;
    this.state = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      processed: 0,
      total: 0,
      failed: 0,
      written: 0,
      provider,
      model,
      batchId,
      error: null,
    };
    void this.run(spec, batchId);
    return true;
  }

  private async run(spec: IngredientNamerStartSpec, batchId: string): Promise<void> {
    try {
      const targetLocales: Locale[] =
        spec.targetLocales && spec.targetLocales.length > 0
          ? spec.targetLocales
          : [...NON_CANONICAL_LOCALES];

      const targets = await this.collectTargets(spec);
      this.state = { ...this.state, total: targets.length };
      if (targets.length === 0) {
        this.finish(null);
        return;
      }

      const adapter = this.pickAdapter();
      const tuning = PROVIDER_TUNING[adapter.kind];

      for (let i = 0; i < targets.length; i += tuning.batchSize) {
        if (this.cancelRequested) break;
        const batch = targets.slice(i, i + tuning.batchSize);
        await this.processBatch(batch, targetLocales, adapter, tuning.temperature, batchId);
        if (
          tuning.interBatchDelayMs > 0 &&
          i + tuning.batchSize < targets.length &&
          !this.cancelRequested
        ) {
          await this.cancellableSleep(tuning.interBatchDelayMs);
        }
      }
      this.finish(this.cancelRequested ? 'cancelled' : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Ingredient-namer run failed: ${message}`);
      this.state = {
        ...this.state,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: message,
      };
    }
  }

  /** USDA-tagged ingredients whose latest draft is missing or stale (prompt
   *  version mismatch). When `scope === 'specific-slugs'` we honour the
   *  explicit list verbatim and ignore the prompt-version filter — the
   *  operator's intent is "redo these regardless". */
  private async collectTargets(
    spec: IngredientNamerStartSpec,
  ): Promise<{ id: string; slug: string; rawDescription: string }[]> {
    const ingredients = await this.prisma.ingredient.findMany({
      where: {
        tags: { has: 'usda-imported' },
        slug: { not: null },
        ...(spec.scope === 'specific-slugs' && spec.slugs && spec.slugs.length > 0
          ? { slug: { in: spec.slugs } }
          : {}),
      },
      select: { id: true, slug: true, name: true },
    });

    if (spec.scope === 'specific-slugs') {
      return ingredients
        .filter((i): i is { id: string; slug: string; name: string } => i.slug !== null)
        .map((i) => ({ id: i.id, slug: i.slug, rawDescription: i.name }));
    }

    // Skip slugs that already have a PENDING/APPROVED/SHIPPED draft from the
    // current prompt version. REJECTED rows are retried on the next run —
    // the operator may have improved the prompt since.
    const existing = await this.prisma.ingredientNameDraft.findMany({
      where: {
        generatorPrompt: INGREDIENT_NAMER_PROMPT_VERSION,
        status: { in: ['PENDING', 'APPROVED', 'SHIPPED'] },
      },
      select: { ingredientSlug: true },
    });
    const skip = new Set(existing.map((d) => d.ingredientSlug));
    return ingredients
      .filter((i): i is { id: string; slug: string; name: string } => i.slug !== null)
      .filter((i) => !skip.has(i.slug))
      .map((i) => ({ id: i.id, slug: i.slug, rawDescription: i.name }));
  }

  private async processBatch(
    batch: { id: string; slug: string; rawDescription: string }[],
    targetLocales: Locale[],
    adapter: AiProviderAdapter,
    temperature: number,
    batchId: string,
  ): Promise<void> {
    const source: Record<string, string> = {};
    for (const row of batch) source[row.slug] = row.rawDescription;

    const suggestions = await this.askWithRetry(adapter, source, targetLocales, temperature);
    if (!suggestions) {
      // Whole batch rejected — count every row as failed; the operator can
      // retry with a tighter spec or a different model.
      for (let i = 0; i < batch.length; i += 1) this.markFailed();
      return;
    }

    for (const row of batch) {
      const suggestion = suggestions[row.slug];
      if (!suggestion) {
        this.markFailed();
        continue;
      }
      try {
        await this.prisma.ingredientNameDraft.create({
          data: {
            ingredientId: row.id,
            ingredientSlug: row.slug,
            rawDescription: row.rawDescription,
            suggestions: suggestion,
            locales: targetLocales,
            batchId,
            modelUsed: this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null,
            generatorPrompt: INGREDIENT_NAMER_PROMPT_VERSION,
          },
        });
        this.markWritten();
      } catch (err) {
        this.logger.warn(`Failed to persist draft for ${row.slug}: ${describe(err)}`);
        this.markFailed();
      }
    }
  }

  /** Single batch with one retry + stricter reminder, mirroring the
   *  translate runner's loop. Returns sanitised suggestions or null when
   *  the whole batch failed validation. */
  private async askWithRetry(
    adapter: AiProviderAdapter,
    source: Record<string, string>,
    targetLocales: Locale[],
    temperature: number,
  ): Promise<Record<string, import('@diet-app/shared').IngredientNameSuggestion> | null> {
    const failures: { key: string; reason: IngredientNamerValidationReason }[] = [];
    for (const attempt of [0, 1, 2]) {
      try {
        const reminder = attempt === 0
          ? ''
          : '\nReminder: respond with ONLY the COMPLETE JSON object. No prose, no fences, no notes.';
        const prompt =
          buildIngredientNamerPrompt({ targetLocales, source }) + reminder;
        const result = await adapter.chat(
          [{ role: 'user', content: prompt }],
          {
            model: this.config.get('AI_DEFAULT_MODEL', { infer: true })!,
            apiKey: this.adapterKey(adapter),
            baseUrl: this.adapterBaseUrl(adapter),
            temperature,
            json: true,
          },
        );
        const v = validateIngredientNamer({
          source,
          targetLocales,
          rawOutput: result.text,
        });
        if (v.ok) return v.suggestions;
        failures.push({ key: v.key ?? '?', reason: v.reason });
        const head = result.text.slice(0, 200).replace(/\s+/g, ' ');
        this.logger.warn(`namer batch reject (${v.reason}): head="${head}"`);
      } catch (err) {
        this.logger.warn(`namer batch error: ${describe(err)}`);
      }
    }
    if (failures.length > 0) {
      this.logger.warn(
        `namer batch rejected after retries: ${failures
          .map((f) => `${f.key}=${f.reason}`)
          .join(', ')}`,
      );
    }
    return null;
  }

  private finish(error: string | null): void {
    this.state = {
      ...this.state,
      status: 'done',
      finishedAt: new Date().toISOString(),
      error,
    };
  }

  private markWritten(): void {
    this.state = {
      ...this.state,
      processed: this.state.processed + 1,
      written: this.state.written + 1,
    };
  }

  private markFailed(): void {
    this.state = {
      ...this.state,
      processed: this.state.processed + 1,
      failed: this.state.failed + 1,
    };
  }

  private async cancellableSleep(ms: number): Promise<void> {
    const slice = 500;
    let elapsed = 0;
    while (elapsed < ms && !this.cancelRequested) {
      await new Promise((r) => setTimeout(r, Math.min(slice, ms - elapsed)));
      elapsed += slice;
    }
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

  private static idle(): IngredientNamerRunnerState {
    return {
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      processed: 0,
      total: 0,
      failed: 0,
      written: 0,
      provider: null,
      model: null,
      batchId: null,
      error: null,
    };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
