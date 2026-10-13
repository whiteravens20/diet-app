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
  Cuisine,
  DietType,
  MealType,
  NON_CANONICAL_LOCALES,
  RecipeDietTag,
  type Complexity,
  type DraftRunNote,
  type Locale,
  type RecipeGenerateSpec,
} from '@diet-app/shared';
import { CatalogueCoverageService } from '../../catalogue/catalogue-coverage.service.js';
import type { Env } from '../../config/env.js';
import { COVERAGE_TARGET } from '../../engine/coverage.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobState } from '../job-state.js';
import { AnthropicProvider } from '../../ai/providers/anthropic.provider.js';
import { OllamaProvider } from '../../ai/providers/ollama.provider.js';
import { OpenAiProvider } from '../../ai/providers/openai.provider.js';
import { OpenRouterProvider } from '../../ai/providers/openrouter.provider.js';
import type { AiProviderAdapter, CompletionResult } from '../../ai/provider.interface.js';
import { recipeBatch, recipesPerCall } from '../../ai/operations.js';
import { PROVIDER_TUNING } from './ai-helpers.js';
import {
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

type RecipeRunnerStatus = 'idle' | 'running' | 'done' | 'error';

/** What a new recipe is held against. */
interface ExistingRecipes {
  /** For the likeness of ingredients; the prompt shows the first of them. */
  recipes: ExistingRecipeSummary[];
  takenSlugs: Set<string>;
  /** English titles, in lower case. */
  takenTitles: Set<string>;
}

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
  /** Always zero: a run of recipes leaves nothing of its scope out. */
  skipped: number;
  /** Why the run ended before its count, when that is no failure. */
  note: DraftRunNote | null;
  /** The diet and the meal the run is writing for, when it chooses them itself. */
  target: { diet: DietType; meal: MealType } | null;
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
  private readonly job: JobState<RecipeRunnerState>;

  /** Where the run stands as this process knows it. What every process is told is `getState`. */
  private get state(): RecipeRunnerState {
    return this.job.local;
  }

  private set state(next: RecipeRunnerState) {
    this.job.local = next;
  }

  /** Whether somebody asked the run to stop, in whichever process of the API. */
  private get cancelRequested(): boolean {
    return this.job.stopRequested;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly coverage: CatalogueCoverageService,
    private readonly openai: OpenAiProvider,
    private readonly anthropic: AnthropicProvider,
    private readonly openrouter: OpenRouterProvider,
    private readonly ollama: OllamaProvider,
  ) {
    this.job = new JobState(prisma, 'recipe drafts', RecipeGeneratorRunner.idle);
  }

  /** Ask the run to stop, wherever it runs. False when none does. */
  cancel(): Promise<boolean> {
    return this.job.requestStop();
  }

  getState(): Promise<RecipeRunnerState> {
    return this.job.read();
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) &&
        this.config.get('AI_DEFAULT_MODEL', { infer: true }),
    );
  }

  async start(spec: RecipeGenerateSpec): Promise<boolean> {
    if (this.state.status === 'running') return false;
    if (!this.isConfigured()) {
      this.state = {
        ...RecipeGeneratorRunner.idle(),
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: 'AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL not configured',
      };
      await this.job.settle();
      return true;
    }
    const provider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) ?? null;
    const model = this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null;
    const batchId = `rec-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
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
      skipped: 0,
      note: null,
      target: null,
      complexityCounts: { simple: 0, medium: 0, complex: 0 },
      mixDrift: false,
      lastRejectReason: null,
      lastRejectKey: null,
      lastRejectHead: null,
    };
    if (!(await this.job.begin())) return false;
    void this.job.during(() => this.run(spec, batchId));
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

      const existing = await this.loadExisting();

      const adapter = this.pickAdapter();
      const tuning = PROVIDER_TUNING[adapter.kind];
      const perCall = recipesPerCall(targetLocalesWithEn.length);
      const mix = spec.complexityMix ?? DEFAULT_COMPLEXITY_MIX;

      /** One call of the run: how many recipes it wrote, or `null` when the provider itself failed and the run is over. */
      const call = async (targets: Record<Complexity, number>, asking: RecipeGenerateSpec): Promise<number | null> => {
        const asked = targets.simple + targets.medium + targets.complex;
        const answer = await this.askForRecipes({
          adapter,
          temperature: tuning.temperature,
          targets,
          spec: asking,
          targetLocales: targetLocalesWithEn,
          catalogue,
          resolveSlug,
          existing,
        });
        if (answer.failure) {
          // The provider itself is failing; the calls still to come would too.
          this.finishWithError(`provider call failed: ${answer.failure}`);
          return null;
        }
        // Never more than was asked for, whatever the model sent.
        const accepted = answer.candidates.slice(0, asked);
        await this.persistCandidates({
          candidates: accepted,
          spec: asking,
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
        existing.recipes.unshift(...accepted.map((c) => ({ slug: c.slug, ingredientSlugs: c.ingredients.map((i) => i.slug) })));
        for (const c of accepted) {
          existing.takenSlugs.add(c.slug);
          existing.takenTitles.add((c.titles.en ?? '').toLowerCase());
        }
        return accepted.length;
      };
      const pause = async (): Promise<void> => {
        if (tuning.interBatchDelayMs > 0 && !this.cancelRequested) await new Promise((waited) => setTimeout(waited, tuning.interBatchDelayMs));
      };

      if (spec.fillCoverage) {
        // Call after call for the diet and meal that have the fewest recipes,
        // counted anew each time. A pair that yields nothing is left for
        // another run, so that one hard pair does not use up the whole count.
        const gaveNothing = new Set<string>();
        let left = spec.count;
        while (left > 0 && !this.cancelRequested) {
          const cell = await this.emptiestCell(gaveNothing);
          if (cell === null) {
            if (gaveNothing.size === 0) this.state = { ...this.state, note: 'coverage-reached' };
            break;
          }
          const want = Math.min(perCall, left, COVERAGE_TARGET - cell.recipes);
          this.state = { ...this.state, target: { diet: cell.diet, meal: cell.meal } };
          const wrote = await call(planCalls(want, want, mix)[0]!, {
            ...spec,
            // A diet every recipe suits asks nothing of the model.
            dietTags: RecipeDietTag.safeParse(cell.diet).success ? [cell.diet] : undefined,
            mealTypes: [cell.meal],
          });
          if (wrote === null) return;
          if (wrote === 0) gaveNothing.add(`${cell.diet}:${cell.meal}`);
          left -= want;
          if (left > 0) await pause();
        }
      } else {
        // One answer holds only a few recipes, so a run is a series of calls.
        const calls = planCalls(spec.count, perCall, mix);
        for (const [index, targets] of calls.entries()) {
          if (this.cancelRequested) break;
          if ((await call(targets, spec)) === null) return;
          if (index < calls.length - 1) await pause();
        }
      }

      this.summariseMix(spec, this.state.written);
      if (this.cancelRequested) this.finish('cancelled');
      else this.finish(this.state.written === 0 && this.state.note === null ? 'batch rejected on every retry' : null);
    } catch (err) {
      this.finishWithError(describe(err));
    }
  }

  /**
   * One call of a run, with up to three attempts. A recipe of an answer that
   * passes is kept, and the next attempt asks only for those still missing,
   * with what was refused and why. Returns the recipes that were kept (none
   * when every attempt was rejected), or the failure when the provider could
   * not be reached at all.
   */
  private async askForRecipes(opts: {
    adapter: AiProviderAdapter;
    temperature: number;
    targets: Record<Complexity, number>;
    spec: RecipeGenerateSpec;
    targetLocales: Locale[];
    catalogue: CatalogueRow[];
    resolveSlug: (slug: string) => ResolvedIngredient | null;
    existing: ExistingRecipes;
  }): Promise<{ candidates: RecipeDraftCandidate[]; failure: string | null }> {
    const { adapter, targets, spec, targetLocales, existing } = opts;
    const asked = targets.simple + targets.medium + targets.complex;
    const limits = recipeBatch(asked, targetLocales.length, opts.temperature);
    const catalogue = this.catalogueForPrompt(opts.catalogue);
    /** What passed so far: taken, for the attempts after it, like any recipe there is. */
    const kept: RecipeDraftCandidate[] = [];
    const known = (): ExistingRecipes => ({
      recipes: [...existing.recipes, ...kept.map((recipe) => ({ slug: recipe.slug, ingredientSlugs: recipe.ingredients.map((line) => line.slug) }))],
      takenSlugs: new Set([...existing.takenSlugs, ...kept.map((recipe) => recipe.slug)]),
      takenTitles: new Set([...existing.takenTitles, ...kept.map((recipe) => (recipe.titles.en ?? '').toLowerCase())]),
    });

    let failure: string | null = null;
    // What the validator made of the last answer: a code and the slug or the
    // field it is about. Said to the model with the next attempt, so that it
    // does not send the same answer again.
    let refused = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.cancelRequested) break;
      const reminder = attempt === 0
        ? ''
        : `\nReminder: respond with ONLY the COMPLETE JSON object containing {"recipes": [...]}. No prose, no fences, no notes.${refused}`;
      const promptText = buildRecipeGeneratorPrompt({
        targetLocales,
        targets: stillMissing(targets, kept),
        dietTags: spec.dietTags,
        mealTypes: spec.mealTypes,
        cuisine: spec.cuisine,
        kcalRange: spec.kcalRange,
        avoidSlugs: spec.avoidSlugs,
        preferSlugs: spec.preferSlugs,
        catalogue,
        existingRecipes: known().recipes,
      });
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
        ...(({ recipes, takenSlugs, takenTitles }) => ({ existingRecipes: recipes, takenSlugs, takenTitles }))(known()),
        requiredDiets: spec.dietTags,
        requiredMeals: spec.mealTypes,
      });
      const refusals = validation.ok ? validation.refused : [validation];
      if (validation.ok) {
        kept.push(...validation.candidates.slice(0, asked - kept.length));
        // All that was asked for, or an answer nothing was wrong with: the call is done.
        if (kept.length >= asked || refusals.length === 0) return { candidates: kept, failure: null };
      }
      const said = refusals.map((refusal) => `${refusal.reason}${refusal.key ? ` at ${JSON.stringify(refusal.key)}` : ''}`).join('; ');
      refused = validation.ok
        ? `\nOf your last answer these were refused: ${said}. Send ${asked - kept.length} other recipe(s), none of them one of those.`
        : `\nYour last answer was refused: ${said}. Send a corrected answer.`;

      const first = refusals[0]!;
      const detailsSuffix = first.details ? ` [${first.details}]` : '';
      this.logger.warn(
        `recipe batch reject (${first.reason}${first.key ? `, ${first.key}` : ''})${detailsSuffix}, ${refusals.length} refused, ${kept.length} of ${asked} kept: head="${head}"`,
      );
      this.state = {
        ...this.state,
        lastRejectReason: first.reason,
        lastRejectKey: first.key
          ? `${first.key}${detailsSuffix}`
          : first.details ?? null,
        lastRejectHead: head,
      };
    }
    return { candidates: kept, failure };
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

  /**
   * What a new recipe must differ from: the recipes of the shared library and
   * the drafts that wait in the queue, newest first, with every slug and
   * English title that is spoken for. A rejected draft holds nothing: its
   * slug and its title are free again.
   */
  private async loadExisting(): Promise<ExistingRecipes> {
    const library = await this.prisma.recipe.findMany({
      where: { slug: { not: null }, createdByUserId: null },
      orderBy: { createdAt: 'desc' },
      select: { slug: true, title: true, retiredAt: true, ingredients: { select: { ingredient: { select: { slug: true } } } } },
    });
    const queue = await this.prisma.recipeDraft.findMany({
      where: { status: { not: 'REJECTED' } },
      orderBy: { createdAt: 'desc' },
      select: { slug: true, titles: true, ingredientsJson: true, status: true },
    });

    const recipes: ExistingRecipeSummary[] = [];
    const takenSlugs = new Set<string>();
    const takenTitles = new Set<string>();
    for (const recipe of library) {
      // A retired recipe keeps its slug, which is unique among all of them.
      takenSlugs.add(recipe.slug!);
      if (recipe.retiredAt) continue;
      takenTitles.add(recipe.title.toLowerCase());
      const slugs = recipe.ingredients.map((line) => line.ingredient.slug).filter((slug): slug is string => slug !== null);
      if (slugs.length > 0) recipes.push({ slug: recipe.slug!, ingredientSlugs: slugs });
    }
    for (const draft of queue) {
      const title = (draft.titles as Record<string, unknown> | null)?.en;
      if (typeof title === 'string') takenTitles.add(title.toLowerCase());
      const known = takenSlugs.has(draft.slug);
      takenSlugs.add(draft.slug);
      // A draft that shipped into this instance is in the library already.
      if (known || draft.status === 'SHIPPED') continue;
      const lines = Array.isArray(draft.ingredientsJson) ? (draft.ingredientsJson as { slug?: unknown }[]) : [];
      const slugs = lines.map((line) => line?.slug).filter((slug): slug is string => typeof slug === 'string');
      if (slugs.length > 0) recipes.push({ slug: draft.slug, ingredientSlugs: slugs });
    }
    return { recipes, takenSlugs, takenTitles };
  }

  /**
   * The diet and meal with the fewest recipes, counting the shared library
   * and the drafts that wait in the queue, or null when every pair has
   * `COVERAGE_TARGET` (or is one of `setAside`). A diet every recipe suits is
   * left out when a stricter one is as empty: a recipe written for the
   * stricter diet fills both.
   */
  private async emptiestCell(setAside: ReadonlySet<string>): Promise<{ diet: DietType; meal: MealType; recipes: number } | null> {
    const [library, waiting] = await Promise.all([this.coverage.count(), this.coverage.waiting()]);
    let emptiest: { diet: DietType; meal: MealType; recipes: number } | null = null;
    // The diets that need recipes of their own come first in the order of ties.
    const diets = [...RecipeDietTag.options, ...DietType.options.filter((diet) => !RecipeDietTag.safeParse(diet).success && diet !== 'custom')];
    for (const diet of diets) {
      for (const meal of MealType.options) {
        if (setAside.has(`${diet}:${meal}`)) continue;
        const recipes = library[diet][meal] + waiting[diet][meal];
        if (recipes < COVERAGE_TARGET && (emptiest === null || recipes < emptiest.recipes)) emptiest = { diet, meal, recipes };
      }
    }
    return emptiest;
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
            // A run that was pointed at a cuisine the application knows tags what it writes with it.
            cuisine: cuisineNamed(spec.cuisine),
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
      skipped: 0,
      note: null,
      target: null,
      complexityCounts: { simple: 0, medium: 0, complex: 0 },
      mixDrift: false,
      lastRejectReason: null,
      lastRejectKey: null,
      lastRejectHead: null,
    };
  }
}

/**
 * The cuisine a run's direction names, when it names one the application
 * knows: "Middle Eastern" and "middle-eastern" are `middle_eastern`. A
 * direction in other words ("something light for summer") names none.
 */
function cuisineNamed(direction: string | undefined): Cuisine | null {
  if (!direction) return null;
  return Cuisine.safeParse(direction.trim().toLowerCase().replace(/[\s-]+/g, '_')).data ?? null;
}

/**
 * What a call still has to bring, by how much there is to a recipe: what it
 * was asked for less what was kept. A recipe kept in another band than any
 * that was asked for counts against the band with the most still missing.
 */
function stillMissing(targets: Record<Complexity, number>, kept: readonly RecipeDraftCandidate[]): Record<Complexity, number> {
  const left = { ...targets };
  for (const recipe of kept) {
    const band = left[recipe.complexity] > 0 ? recipe.complexity : (Object.keys(left) as Complexity[]).reduce((most, one) => (left[one] > left[most] ? one : most));
    if (left[band] > 0) left[band] -= 1;
  }
  return left;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
