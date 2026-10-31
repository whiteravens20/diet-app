// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Ingredient-namer draft runner.
 *
 * Single-flight job that walks USDA-imported ingredients and asks the
 * admin-default AI provider to propose friendly culinary names per
 * `targetLocales`. Drafts land in `IngredientNameDraft` as PENDING; the live
 * `Ingredient` table is never touched. The model is told the names people
 * refused for an ingredient, and giving one again is refused. An ingredient
 * has one proposal waiting at a time: a new one rejects the one it replaces.
 *
 * Single-flight + cancel + state shape so the admin panel can poll one
 * consistent payload.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { NON_CANONICAL_LOCALES, type DraftRunNote, type Locale } from '@diet-app/shared';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobState } from '../job-state.js';
import { AnthropicProvider } from '../../ai/providers/anthropic.provider.js';
import { OllamaProvider } from '../../ai/providers/ollama.provider.js';
import { OpenAiProvider } from '../../ai/providers/openai.provider.js';
import { OpenRouterProvider } from '../../ai/providers/openrouter.provider.js';
import type { AiProviderAdapter } from '../../ai/provider.interface.js';
import { PROVIDER_TUNING } from './ai-helpers.js';
import { ingredientNames, namesPerCall } from '../../ai/operations.js';
import { DraftService, type Actor } from './draft.service.js';
import {
  importedIngredients,
  readNameQueue,
  refusedNames,
  waitingNames,
  type NameTarget,
  type WaitingName,
} from './ingredient-name-queue.js';
import {
  INGREDIENT_NAMER_PROMPT_VERSION,
  buildIngredientNamerPrompt,
  type RefusedName,
} from './ingredient-namer.prompt.js';
import {
  validateIngredientNamer,
  type IngredientNamerValidationReason,
} from './ingredient-namer.validate.js';

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
  /** Ingredients of the run's scope that it had nothing to do for. */
  skipped: number;
  /** Why the run named nothing, when that is no failure. */
  note: DraftRunNote | null;
}

export type IngredientNamerStartSpec = { targetLocales?: Locale[] } & (
  | { scope: 'all-usda-missing' | 'rejected' }
  | { scope: 'specific-slugs'; slugs: string[] }
  /** Proposals in place of drafts that wait: those of `ids`, or every unapproved one. */
  | { scope: 'replacing'; ids?: string[]; by: Actor; reason?: string }
);

/** An ingredient a run names, and the draft whose place its new name takes. */
type Target = NameTarget & { replaces?: WaitingName };

@Injectable()
export class IngredientNamerRunner {
  private readonly logger = new Logger(IngredientNamerRunner.name);
  private readonly job: JobState<IngredientNamerRunnerState>;

  /** Where the run stands as this process knows it. What every process is told is `getState`. */
  private get state(): IngredientNamerRunnerState {
    return this.job.local;
  }

  private set state(next: IngredientNamerRunnerState) {
    this.job.local = next;
  }

  /** Whether somebody asked the run to stop, in whichever process of the API. */
  private get cancelRequested(): boolean {
    return this.job.stopRequested;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly openai: OpenAiProvider,
    private readonly anthropic: AnthropicProvider,
    private readonly openrouter: OpenRouterProvider,
    private readonly ollama: OllamaProvider,
    private readonly drafts: DraftService,
  ) {
    this.job = new JobState(prisma, 'ingredient names', IngredientNamerRunner.idle);
  }

  /** Ask the run to stop, wherever it runs. False when none does. */
  cancel(): Promise<boolean> {
    return this.job.requestStop();
  }

  getState(): Promise<IngredientNamerRunnerState> {
    return this.job.read();
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) &&
      this.config.get('AI_DEFAULT_MODEL', { infer: true }),
    );
  }

  async start(spec: IngredientNamerStartSpec): Promise<boolean> {
    if (this.state.status === 'running') return false;
    if (!this.isConfigured()) {
      this.state = {
        ...IngredientNamerRunner.idle(),
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: 'AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL not configured',
      };
      await this.job.settle();
      return true;
    }
    const provider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) ?? null;
    const model = this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null;
    const batchId = `ing-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
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
      skipped: 0,
      note: null,
    };
    if (!(await this.job.begin())) return false;
    void this.job.during(() => this.run(spec, batchId));
    return true;
  }

  private async run(spec: IngredientNamerStartSpec, batchId: string): Promise<void> {
    try {
      const targetLocales: Locale[] =
        spec.targetLocales && spec.targetLocales.length > 0
          ? spec.targetLocales
          : [...NON_CANONICAL_LOCALES];

      const { targets, skipped, note } = await this.collectTargets(spec);
      this.state = { ...this.state, total: targets.length, skipped, note };
      if (targets.length === 0) {
        this.finish(null);
        return;
      }

      const replaces = targets.flatMap((target) => target.replaces?.draftId ?? []);
      const refused = await refusedNames(
        this.prisma,
        targets.map((target) => target.slug),
        { ids: replaces, reason: spec.scope === 'replacing' ? spec.reason : undefined },
      );

      const adapter = this.pickAdapter();
      const tuning = PROVIDER_TUNING[adapter.kind];
      // No more names per call than fit one answer.
      const batchSize = Math.min(tuning.batchSize, namesPerCall(targetLocales.length));

      for (let i = 0; i < targets.length; i += batchSize) {
        if (this.cancelRequested) break;
        const batch = targets.slice(i, i + batchSize);
        await this.processBatch(
          batch,
          targetLocales,
          adapter,
          tuning.temperature,
          batchId,
          refused,
          spec,
        );
        if (
          tuning.interBatchDelayMs > 0 &&
          i + batchSize < targets.length &&
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

  /**
   * The ingredients a run names: imported ones, which arrive with the names of
   * their source. `all-usda-missing` takes those that never had a proposal,
   * `rejected` those whose last one was rejected, `specific-slugs` those named,
   * and `replacing` the drafts that wait, for their ingredients. An ingredient
   * with a proposal waiting gets no second one beside it. A run that is left
   * with nothing says why.
   */
  private async collectTargets(spec: IngredientNamerStartSpec): Promise<{
    targets: Target[];
    skipped: number;
    note: DraftRunNote | null;
  }> {
    if (spec.scope === 'replacing') {
      const waiting = spec.ids
        ? await waitingNames(this.prisma, spec.ids)
        : (await readNameQueue(this.prisma)).unapproved;
      const skipped = spec.ids ? new Set(spec.ids).size - waiting.length : 0;
      return {
        targets: waiting.map((replaces) => ({ ...replaces, replaces })),
        skipped,
        note:
          waiting.length === 0 ? 'nothing-to-write-again' : skipped > 0 ? 'left-as-they-are' : null,
      };
    }

    if (spec.scope === 'specific-slugs') {
      const asked = new Set(spec.slugs);
      const named = (await importedIngredients(this.prisma)).filter((i) => asked.has(i.slug));
      if (named.length === 0) return { targets: [], skipped: asked.size, note: 'not-imported' };
      const waiting = await this.prisma.ingredientNameDraft.findMany({
        where: {
          ingredientSlug: { in: named.map((i) => i.slug) },
          status: { in: ['PENDING', 'APPROVED'] },
        },
        select: { ingredientSlug: true },
      });
      const taken = new Set(waiting.map((draft) => draft.ingredientSlug));
      const targets = named.filter((i) => !taken.has(i.slug));
      return {
        targets,
        skipped: asked.size - targets.length,
        note: targets.length === 0 ? 'all-have-drafts' : null,
      };
    }

    const imported = await importedIngredients(this.prisma);
    if (imported.length === 0) return { targets: [], skipped: 0, note: 'nothing-imported' };
    const queue = await readNameQueue(this.prisma);
    const targets = spec.scope === 'rejected' ? queue.rejected : queue.missing;
    return {
      targets,
      skipped: imported.length - targets.length,
      note:
        targets.length > 0
          ? null
          : spec.scope === 'rejected'
            ? 'nothing-to-write-again'
            : 'all-have-drafts',
    };
  }

  private async processBatch(
    batch: Target[],
    targetLocales: Locale[],
    adapter: AiProviderAdapter,
    temperature: number,
    batchId: string,
    refused: Record<string, RefusedName[]>,
    spec: IngredientNamerStartSpec,
  ): Promise<void> {
    const source: Record<string, string> = {};
    for (const row of batch) source[row.slug] = row.rawDescription;

    const suggestions = await this.askWithRetry(
      adapter,
      source,
      targetLocales,
      temperature,
      refused,
    );
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
        const data = {
          ingredientId: row.id,
          ingredientSlug: row.slug,
          rawDescription: row.rawDescription,
          suggestions: suggestion,
          locales: targetLocales,
          batchId,
          modelUsed: this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null,
          generatorPrompt: INGREDIENT_NAMER_PROMPT_VERSION,
        };
        const written =
          row.replaces && spec.scope === 'replacing'
            ? await this.drafts.replaceIngredientName(
                row.replaces.draftId,
                row.replaces.updatedAt,
                data,
                spec.reason,
                spec.by,
              )
            : await this.drafts.addIngredientName(data);
        if (written) this.markWritten();
        else this.markLeft();
      } catch (err) {
        this.logger.warn(`Failed to persist draft for ${row.slug}: ${describe(err)}`);
        this.markFailed();
      }
    }
  }

  /**
   * One batch, asked up to three times. A name is judged by itself: what
   * passes is kept, and the next attempt asks only for the names still
   * missing and says what was refused. Returns the names that passed, or
   * null when none did.
   */
  private async askWithRetry(
    adapter: AiProviderAdapter,
    source: Record<string, string>,
    targetLocales: Locale[],
    temperature: number,
    refusedBefore: Record<string, RefusedName[]>,
  ): Promise<Record<string, import('@diet-app/shared').IngredientNameSuggestion> | null> {
    const failures: { key: string; reason: IngredientNamerValidationReason | 'answer-cut-off' }[] =
      [];
    const kept: Record<string, import('@diet-app/shared').IngredientNameSuggestion> = {};
    let refused = '';
    for (const attempt of [0, 1, 2]) {
      const missing = Object.fromEntries(
        Object.entries(source).filter(([slug]) => !(slug in kept)),
      );
      if (Object.keys(missing).length === 0) break;
      const limits = ingredientNames(
        Object.keys(missing).length,
        targetLocales.length,
        temperature,
      );
      try {
        const reminder =
          attempt === 0
            ? ''
            : `\nReminder: respond with ONLY the COMPLETE JSON object. No prose, no fences, no notes.${refused}`;
        const prompt =
          buildIngredientNamerPrompt({
            targetLocales,
            source: missing,
            refused: refusedBefore,
          }) + reminder;
        const result = await adapter.chat([{ role: 'user', content: prompt }], {
          model: this.config.get('AI_DEFAULT_MODEL', { infer: true })!,
          apiKey: this.adapterKey(adapter),
          baseUrl: this.adapterBaseUrl(adapter),
          json: true,
          maxTokens: limits.maxTokens,
          temperature: limits.temperature,
          timeoutMs: limits.timeoutMs,
        });
        if (result.truncated) {
          // A cut-off answer is not worth parsing: its JSON does not close.
          failures.push({ key: '?', reason: 'answer-cut-off' });
          this.logger.warn(`namer batch cut off at ${limits.maxTokens} tokens`);
          continue;
        }
        const v = validateIngredientNamer({
          source: missing,
          targetLocales,
          rawOutput: result.text,
          refused: refusedBefore,
        });
        const refusals = v.ok ? v.refused : [{ key: v.key ?? '?', reason: v.reason }];
        if (v.ok) Object.assign(kept, v.suggestions);
        if (refusals.length === 0) break;
        failures.push(...refusals);
        const said = refusals
          .map((refusal) => `${refusal.reason} at ${JSON.stringify(refusal.key)}`)
          .join('; ');
        refused = `\nOf your last answer these were refused: ${said}. Name them again, otherwise than before.`;
        const head = result.text.slice(0, 200).replace(/\s+/g, ' ');
        this.logger.warn(
          `namer batch reject (${refusals[0]!.reason}), ${refusals.length} refused, ${Object.keys(kept).length} of ${Object.keys(source).length} kept: head="${head}"`,
        );
      } catch (err) {
        this.logger.warn(`namer batch error: ${describe(err)}`);
      }
    }
    const left = Object.keys(source).filter((slug) => !(slug in kept));
    if (left.length > 0) {
      this.logger.warn(
        `namer batch: ${left.length} of ${Object.keys(source).length} not named after retries (${left.slice(0, 5).join(', ')}): ${failures
          .slice(-8)
          .map((f) => `${f.key}=${f.reason}`)
          .join(', ')}`,
      );
    }
    return Object.keys(kept).length > 0 ? kept : null;
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

  /** A draft a person changed or decided on while the run wrote its new name: it stays as it is. */
  private markLeft(): void {
    this.state = {
      ...this.state,
      processed: this.state.processed + 1,
      skipped: this.state.skipped + 1,
      note: 'left-as-they-are',
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
        return this.config.get('OPENAI_API_KEY', { infer: true });
      case 'anthropic':
        return this.config.get('ANTHROPIC_API_KEY', { infer: true });
      case 'openrouter':
        return this.config.get('OPENROUTER_API_KEY', { infer: true });
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
      skipped: 0,
      note: null,
    };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
