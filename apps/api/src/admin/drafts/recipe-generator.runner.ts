// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Recipe draft runner.
 *
 * Single-flight job. The operator submits a `RecipeGenerateSpec`; the runner
 * fetches the curated + USDA-imported ingredient catalogue (rendered into the
 * prompt as the hard whitelist), asks the admin-default AI provider to author
 * the recipes a few per call (as many as fit one answer), runs every row
 * through the validator (engine recompute included), and persists accepted
 * candidates as `RecipeDraft` rows with `status = PENDING`. Rejected rows are
 * counted in `failed` and the row is dropped — same philosophy as the
 * ingredient namer.
 *
 * Mirrors the state shape + cancel + pickAdapter pattern from the ingredient
 * namer so the controller can return one unified payload.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  NON_CANONICAL_LOCALES,
  type Complexity,
  type Locale,
  type RecipeGenerateSpec,
} from '@diet-app/shared';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AnthropicProvider } from '../../ai/providers/anthropic.provider.js';
import { OllamaProvider } from '../../ai/providers/ollama.provider.js';
import { OpenAiProvider } from '../../ai/providers/openai.provider.js';
import { OpenRouterProvider } from '../../ai/providers/openrouter.provider.js';
import type { AiProviderAdapter, CompletionResult } from '../../ai/provider.interface.js';
import { recipeBatch, recipesPerCall } from '../../ai/operations.js';
import { PROVIDER_TUNING } from './ai-helpers.js';
import {
  MAX_EXISTING_RECIPES_IN_PROMPT,
  RECIPE_GENERATOR_PROMPT_VERSION,
  buildRecipeGeneratorPrompt,
  type CatalogueRow,
  type ExistingRecipeSummary,
} from './recipe-generator.prompt.js';
import {
  validateRecipeBatch,
  type RecipeDraftCandidate,
  type ResolvedIngredient,
} from './recipe-generator.validate.js';
import {
  batchMixDrift,
  DEFAULT_COMPLEXITY_MIX,
  planCalls,
} from './recipe-generator.complexity.js';

export type RecipeRunnerStatus = 'idle' | 'running' | 'done' | 'error';

export interface RecipeRunnerState {
  status: RecipeRunnerStatus;
  startedAt: string | null;
  finishedAt: string | null;
  processed: number;
  total: number;
  failed: number;
  written: number;
  provider: string | null;
  model: string | null;
  batchId: string | null;
  error: string | null;
  /** Realised complexity counts in the run. Surfaced beside the progress bar
   *  so the operator can see the batch skew live. */
  complexityCounts: Record<Complexity, number>;
  /** Yellow-chip warning when realised mix drifts > 25 pp in any band. */
  mixDrift: boolean;
  /** Why the most recent batch was rejected (e.g. `unknown-slug`,
   *  `invalid-unit`). Surfaced in the UI so the operator doesn't need to
   *  read API logs to debug. */
  lastRejectReason: string | null;
  /** Which key triggered the most recent rejection, if applicable. */
  lastRejectKey: string | null;
  /** First ~200 chars of the rejected model output. Helps diagnose
   *  malformed JSON / truncated output / wrong shape. */
  lastRejectHead: string | null;
}

@Injectable()
export class RecipeGeneratorRunner {
  private readonly logger = new Logger(RecipeGeneratorRunner.name);
  private state: RecipeRunnerState = RecipeGeneratorRunner.idle();
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

  getState(): RecipeRunnerState {
    return this.state;
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) &&
        this.config.get('AI_DEFAULT_MODEL', { infer: true }),
    );
  }

  start(spec: RecipeGenerateSpec): boolean {
    if (this.state.status === 'running') return false;
    if (!this.isConfigured()) {
      this.state = {
        ...RecipeGeneratorRunner.idle(),
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: 'AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL not configured',
      };
      return true;
    }
    const provider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) ?? null;
    const model = this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null;
    const batchId = `rec-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.cancelRequested = false;
    this.state = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      processed: 0,
      total: spec.count,
      failed: 0,
      written: 0,
      provider,
      model,
      batchId,
      error: null,
      complexityCounts: { simple: 0, medium: 0, complex: 0 },
      mixDrift: false,
      lastRejectReason: null,
      lastRejectKey: null,
      lastRejectHead: null,
    };
    void this.run(spec, batchId);
    return true;
  }

  private async run(spec: RecipeGenerateSpec, batchId: string): Promise<void> {
    try {
      const targetLocales: Locale[] =
        spec.targetLocales && spec.targetLocales.length > 0
          ? spec.targetLocales
          : (['en', ...NON_CANONICAL_LOCALES] as Locale[]);
      const targetLocalesWithEn: Locale[] = targetLocales.includes('en' as Locale)
        ? targetLocales
        : (['en', ...targetLocales] as Locale[]);

      const catalogue = await this.loadCatalogue(
        targetLocalesWithEn,
        spec.catalogueScope ?? 'curated',
      );
      const resolverMap = new Map<string, ResolvedIngredient>();
      for (const c of catalogue) {
        resolverMap.set(c.slug, {
          slug: c.slug,
          canonicalUnit: c.canonicalUnit,
          gramsPerPiece: c.gramsPerPiece,
          density: c.density,
          caloriesPer100: c.caloriesPer100,
          proteinPer100: c.proteinPer100,
          fatPer100: c.fatPer100,
          carbsPer100: c.carbsPer100,
          allergens: c.allergens,
          dietCompatibility: c.dietCompatibility,
        });
      }
      const resolveSlug = (slug: string) => resolverMap.get(slug) ?? null;

      const existingRecipes = await this.loadExistingRecipes();

      const adapter = this.pickAdapter();
      const tuning = PROVIDER_TUNING[adapter.kind];
      // One answer holds only a few recipes, so a run is a series of calls.
      const calls = planCalls(
        spec.count,
        recipesPerCall(targetLocalesWithEn.length),
        spec.complexityMix ?? DEFAULT_COMPLEXITY_MIX,
      );

      for (const [index, targets] of calls.entries()) {
        if (this.cancelRequested) break;
        const asked = targets.simple + targets.medium + targets.complex;
        const answer = await this.askForRecipes({
          adapter,
          temperature: tuning.temperature,
          targets,
          spec,
          targetLocales: targetLocalesWithEn,
          catalogue,
          resolveSlug,
          existingRecipes,
        });
        if (answer.failure) {
          // The provider itself is failing; the calls still to come would too.
          this.finishWithError(`provider call failed: ${answer.failure}`);
          return;
        }
        if (this.cancelRequested && answer.candidates.length === 0) break;
        // Never more than was asked for, whatever the model sent.
        const accepted = answer.candidates.slice(0, asked);
        await this.persistCandidates({
          candidates: accepted,
          spec,
          targetLocales: targetLocalesWithEn,
          batchId,
        });
        const missing = asked - accepted.length;
        this.state = {
          ...this.state,
          processed: this.state.processed + missing,
          failed: this.state.failed + missing,
        };
        // The calls still to come must not repeat what this one wrote.
        existingRecipes.unshift(
          ...accepted.map((c) => ({
            slug: c.slug,
            titleEn: c.titles.en ?? c.slug,
            ingredientSlugs: c.ingredients.map((i) => i.slug),
          })),
        );
        if (tuning.interBatchDelayMs > 0 && index < calls.length - 1 && !this.cancelRequested) {
          await new Promise((waited) => setTimeout(waited, tuning.interBatchDelayMs));
        }
      }

      this.summariseMix(spec, this.state.written);
      if (this.cancelRequested) this.finish('cancelled');
      else this.finish(this.state.written === 0 ? 'batch rejected on every retry' : null);
    } catch (err) {
      this.finishWithError(describe(err));
    }
  }

  /**
   * One call of a run, with up to three attempts. Returns the recipes that
   * passed validation (none when every attempt was rejected), or the failure
   * when the provider could not be reached at all.
   */
  private async askForRecipes(opts: {
    adapter: AiProviderAdapter;
    temperature: number;
    targets: Record<Complexity, number>;
    spec: RecipeGenerateSpec;
    targetLocales: Locale[];
    catalogue: CatalogueRow[];
    resolveSlug: (slug: string) => ResolvedIngredient | null;
    existingRecipes: ExistingRecipeSummary[];
  }): Promise<{ candidates: RecipeDraftCandidate[]; failure: string | null }> {
    const { adapter, targets, spec, targetLocales, existingRecipes } = opts;
    const asked = targets.simple + targets.medium + targets.complex;
    const limits = recipeBatch(asked, targetLocales.length, opts.temperature);
    const promptText = buildRecipeGeneratorPrompt({
      targetLocales,
      targets,
      dietTags: spec.dietTags,
      mealTypes: spec.mealTypes,
      cuisine: spec.cuisine,
      kcalRange: spec.kcalRange,
      avoidSlugs: spec.avoidSlugs,
      preferSlugs: spec.preferSlugs,
      catalogue: this.catalogueForPrompt(opts.catalogue),
      existingRecipes,
    });

    let failure: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.cancelRequested) break;
      const reminder = attempt === 0
        ? ''
        : '\nReminder: respond with ONLY the COMPLETE JSON object containing {"recipes": [...]}. No prose, no fences, no notes.';
      let result: CompletionResult;
      try {
        result = await adapter.chat([{ role: 'user', content: promptText + reminder }], {
          model: this.config.get('AI_DEFAULT_MODEL', { infer: true })!,
          apiKey: this.adapterKey(adapter),
          baseUrl: this.adapterBaseUrl(adapter),
          json: true,
          maxTokens: limits.maxTokens,
          temperature: limits.temperature,
          timeoutMs: limits.timeoutMs,
        });
      } catch (err) {
        failure = describe(err);
        this.logger.warn(`recipe-gen call failed (attempt ${attempt}): ${failure}`);
        continue;
      }
      failure = null;

      const head = result.text.slice(0, 200).replace(/\s+/g, ' ');
      if (result.truncated) {
        // A cut-off answer is not worth parsing: its JSON does not close.
        this.logger.warn(`recipe batch cut off at ${limits.maxTokens} tokens: head="${head}"`);
        this.state = {
          ...this.state,
          lastRejectReason: 'answer-cut-off',
          lastRejectKey: null,
          lastRejectHead: head,
        };
        continue;
      }
      const validation = validateRecipeBatch({
        targetLocales,
        rawOutput: result.text,
        resolveSlug: opts.resolveSlug,
        existingRecipes,
      });
      if (validation.ok) return { candidates: validation.candidates, failure: null };

      const detailsSuffix = validation.details ? ` [${validation.details}]` : '';
      this.logger.warn(
        `recipe batch reject (${validation.reason}${validation.key ? `, ${validation.key}` : ''})${detailsSuffix}: head="${head}"`,
      );
      this.state = {
        ...this.state,
        lastRejectReason: validation.reason,
        lastRejectKey: validation.key
          ? `${validation.key}${detailsSuffix}`
          : validation.details ?? null,
        lastRejectHead: head,
      };
    }
    return { candidates: [], failure };
  }

  private async loadCatalogue(
    _locales: Locale[],
    scope: 'curated' | 'all',
  ): Promise<CatalogueRow[]> {
    // `curated` excludes USDA-imported rows. They carry FDC-bureaucratic names
    // the model can't reliably pick from; until they have approved friendly
    // names via the namer pipeline, they sit out of recipe generation.
    const where =
      scope === 'curated'
        ? { slug: { not: null }, retiredAt: null, NOT: { tags: { has: 'usda-imported' } } }
        : { slug: { not: null }, retiredAt: null };
    const ingredients = await this.prisma.ingredient.findMany({
      where,
      select: {
        slug: true,
        name: true,
        category: true,
        canonicalUnit: true,
        caloriesPer100: true,
        proteinPer100: true,
        fatPer100: true,
        carbsPer100: true,
        gramsPerPiece: true,
        density: true,
        allergens: true,
        dietCompatibility: true,
        translations: { select: { locale: true, name: true } },
      },
    });
    const rows: CatalogueRow[] = [];
    for (const i of ingredients) {
      if (!i.slug) continue;
      const names: Record<string, string> = {};
      // Always include the EN canonical from the parent row so the prompt
      // can map intent → slug even when translations are sparse.
      names.en = i.name;
      for (const t of i.translations) names[t.locale] = t.name;
      rows.push({
        slug: i.slug,
        names,
        category: i.category,
        canonicalUnit: i.canonicalUnit,
        caloriesPer100: i.caloriesPer100,
        proteinPer100: i.proteinPer100,
        fatPer100: i.fatPer100,
        carbsPer100: i.carbsPer100,
        gramsPerPiece: i.gramsPerPiece,
        density: i.density,
        allergens: i.allergens,
        dietCompatibility: i.dietCompatibility,
      });
    }
    return rows;
  }

  /** Load existing recipes (live + pending drafts) for dedup. Returns a
   *  capped, newest-first list so the prompt stays bounded as the library
   *  grows. The validator uses the same list for the Jaccard check, so the
   *  model sees every recipe it's being held to. */
  private async loadExistingRecipes(): Promise<ExistingRecipeSummary[]> {
    const cap = MAX_EXISTING_RECIPES_IN_PROMPT;
    const live = await this.prisma.recipe.findMany({
      where: { slug: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: cap,
      select: {
        slug: true,
        title: true,
        ingredients: { select: { ingredient: { select: { slug: true } } } },
      },
    });
    const pending = await this.prisma.recipeDraft.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] } },
      orderBy: { createdAt: 'desc' },
      take: cap,
      select: {
        slug: true,
        titles: true,
        ingredientsJson: true,
      },
    });
    const out: ExistingRecipeSummary[] = [];
    for (const r of live) {
      if (!r.slug) continue;
      const slugs = r.ingredients
        .map((ri) => ri.ingredient?.slug)
        .filter((s): s is string => Boolean(s));
      if (slugs.length === 0) continue;
      out.push({ slug: r.slug, titleEn: r.title, ingredientSlugs: slugs });
    }
    const seen = new Set(out.map((r) => r.slug));
    for (const d of pending) {
      if (seen.has(d.slug)) continue;
      const titles = (d.titles ?? {}) as Record<string, string>;
      const lines = (d.ingredientsJson ?? []) as { slug?: unknown }[];
      const slugs = lines
        .map((l) => (typeof l?.slug === 'string' ? l.slug : null))
        .filter((s): s is string => Boolean(s));
      if (slugs.length === 0) continue;
      out.push({
        slug: d.slug,
        titleEn: typeof titles.en === 'string' ? titles.en : d.slug,
        ingredientSlugs: slugs,
      });
      seen.add(d.slug);
    }
    return out.slice(0, cap);
  }

  /** Trim per-100 macros to one decimal to keep the prompt compact. */
  private catalogueForPrompt(catalogue: CatalogueRow[]): CatalogueRow[] {
    return catalogue.map((c) => ({
      ...c,
      caloriesPer100: Math.round(c.caloriesPer100),
      proteinPer100: Math.round(c.proteinPer100 * 10) / 10,
      fatPer100: Math.round(c.fatPer100 * 10) / 10,
      carbsPer100: Math.round(c.carbsPer100 * 10) / 10,
    }));
  }

  private async persistCandidates(opts: {
    candidates: RecipeDraftCandidate[];
    spec: RecipeGenerateSpec;
    targetLocales: Locale[];
    batchId: string;
  }): Promise<void> {
    const { candidates, spec, targetLocales, batchId } = opts;
    const model = this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null;
    for (const c of candidates) {
      try {
        await this.prisma.recipeDraft.create({
          data: {
            slug: c.slug,
            titles: c.titles,
            descriptions: c.descriptions,
            steps: c.steps,
            locales: targetLocales,
            servings: c.servings,
            mealTypes: c.mealTypes,
            dietTags: c.dietTags,
            prepMinutes: c.prepMinutes,
            cookMinutes: c.cookMinutes,
            difficulty: c.difficulty,
            complexity: c.complexity,
            caloriesPerServing: c.caloriesPerServing,
            proteinPerServing: c.proteinPerServing,
            fatPerServing: c.fatPerServing,
            carbsPerServing: c.carbsPerServing,
            allergens: c.allergens,
            ingredientsJson: c.ingredients,
            batchId,
            modelUsed: model,
            generatorPrompt: RECIPE_GENERATOR_PROMPT_VERSION,
            generationSpec: spec as object,
          },
        });
        this.state = {
          ...this.state,
          processed: this.state.processed + 1,
          written: this.state.written + 1,
          complexityCounts: {
            ...this.state.complexityCounts,
            [c.complexity]: this.state.complexityCounts[c.complexity] + 1,
          },
        };
      } catch (err) {
        this.logger.warn(`failed to persist recipe draft ${c.slug}: ${describe(err)}`);
        this.state = {
          ...this.state,
          processed: this.state.processed + 1,
          failed: this.state.failed + 1,
        };
      }
    }
  }

  private summariseMix(spec: RecipeGenerateSpec, accepted: number): void {
    const target = spec.complexityMix ?? DEFAULT_COMPLEXITY_MIX;
    const drift = batchMixDrift({
      realised: this.state.complexityCounts,
      target,
      total: accepted,
    });
    if (drift.drifted) {
      this.logger.warn(
        `batch ${this.state.batchId} mix drift > 25pp: ${JSON.stringify(drift.deltas)}`,
      );
      this.state = { ...this.state, mixDrift: true };
    }
  }

  private finish(error: string | null): void {
    this.state = {
      ...this.state,
      status: 'done',
      finishedAt: new Date().toISOString(),
      error,
    };
  }

  private finishWithError(message: string): void {
    this.logger.error(`Recipe generator failed: ${message}`);
    this.state = {
      ...this.state,
      status: 'error',
      finishedAt: new Date().toISOString(),
      error: message,
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

  private static idle(): RecipeRunnerState {
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
      complexityCounts: { simple: 0, medium: 0, complex: 0 },
      mixDrift: false,
      lastRejectReason: null,
      lastRejectKey: null,
      lastRejectHead: null,
    };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
