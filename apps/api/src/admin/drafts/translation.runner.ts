// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The run that fills a language recipes lack.
 *
 * It asks the instance's model for the text of a recipe in one language, from
 * the English that people approved, and puts what comes back into the
 * curation queue. It writes no live row:
 *
 *  - a recipe draft that waits without the language gets its text in it, and
 *    has to be reviewed in it before it ships;
 *  - a recipe of the instance's own library without the language gets a
 *    draft of itself: the recipe as it is, with the new text beside its
 *    English. Shipped into the instance, that draft adds the language to the
 *    recipe and changes nothing else (`ship/library.ts`).
 *
 * Left alone on purpose: the recipes of the catalogue's data files, whose
 * text is written and reviewed by hand in the repository. The names of
 * ingredients are no part of this run either: an imported ingredient gets its
 * name in each language from the run that names ingredients, which writes
 * from the description of the source and not from another language.
 *
 * Single-flight, stoppable, with the state shape of the other draft runs.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DraftRunNote, Locale } from '@diet-app/shared';
import { recipeTranslation } from '../../ai/operations.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobState } from '../job-state.js';
import { AdminModelService } from './admin-model.service.js';
import { DraftService } from './draft.service.js';
import { localeMap, localeStepsMap } from './drafts.mapper.js';
import type { DraftRunnerStatus } from './ingredient-namer.runner.js';
import { classifyComplexity } from './recipe-generator.complexity.js';
import {
  TRANSLATION_PROMPT_VERSION,
  buildRecipeTranslationPrompt,
  type RecipeTextSource,
} from './translation.prompt.js';
import { validateRecipeTranslation } from './translation.validate.js';

export interface TranslationRunnerState {
  status: DraftRunnerStatus;
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
  /** What the run found done by somebody else when its turn came. */
  skipped: number;
  note: DraftRunNote | null;
}

export interface TranslationStartSpec {
  /** The language to fill; never English, which everything is written from. */
  locale: Locale;
  /** The most the run takes on. */
  limit: number;
}

/** How often a recipe is asked for again when the answer is no use. */
const ATTEMPTS = 2;
const WAITING = ['PENDING', 'APPROVED'] as const;

@Injectable()
export class TranslationRunner {
  private readonly logger = new Logger(TranslationRunner.name);
  private readonly job: JobState<TranslationRunnerState>;

  private get state(): TranslationRunnerState {
    return this.job.local;
  }

  private set state(next: TranslationRunnerState) {
    this.job.local = next;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly model: AdminModelService,
    private readonly drafts: DraftService,
  ) {
    this.job = new JobState(prisma, 'translations', TranslationRunner.idle);
  }

  /** Ask the run to stop, wherever it runs. False when none does. */
  cancel(): Promise<boolean> {
    return this.job.requestStop();
  }

  getState(): Promise<TranslationRunnerState> {
    return this.job.read();
  }

  async start(spec: TranslationStartSpec): Promise<boolean> {
    if (this.state.status === 'running') return false;
    if (!this.model.configured) {
      this.state = {
        ...TranslationRunner.idle(),
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: 'AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL not configured',
      };
      await this.job.settle();
      return true;
    }
    const batchId = `tr-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.state = {
      ...TranslationRunner.idle(),
      status: 'running',
      startedAt: new Date().toISOString(),
      provider: this.model.provider,
      model: this.model.model,
      batchId,
    };
    if (!(await this.job.begin())) return false;
    void this.job.during(() => this.run(spec, batchId));
    return true;
  }

  private async run(spec: TranslationStartSpec, batchId: string): Promise<void> {
    try {
      await this.recipes(spec, batchId);
      this.state = {
        ...this.state,
        status: 'done',
        finishedAt: new Date().toISOString(),
        error: this.job.stopRequested ? 'cancelled' : null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`The run that fills a language failed: ${message}`);
      this.state = {
        ...this.state,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: message,
      };
    }
  }

  private async recipes({ locale, limit }: TranslationStartSpec, batchId: string): Promise<void> {
    // The drafts that wait come first: they are what somebody is about to review.
    const waiting = await this.prisma.recipeDraft.findMany({
      where: {
        status: { in: [...WAITING] },
        locales: { has: 'en' },
        NOT: { locales: { has: locale } },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, slug: true, titles: true, descriptions: true, steps: true },
    });
    const own =
      waiting.length < limit ? await this.ownRecipesWithout(locale, limit - waiting.length) : [];
    this.state = {
      ...this.state,
      total: waiting.length + own.length,
      note: waiting.length + own.length === 0 ? 'nothing-to-translate' : null,
    };

    for (const draft of waiting) {
      if (this.job.stopRequested) return;
      const source = {
        title: localeMap(draft.titles).en ?? '',
        description: localeMap(draft.descriptions).en ?? '',
        steps: localeStepsMap(draft.steps).en ?? [],
      };
      const text = await this.translated(locale, source, draft.slug);
      if (!text) {
        this.count('failed');
        continue;
      }
      try {
        this.count(
          (await this.drafts.addRecipeLanguage(draft.id, locale, text)) ? 'written' : 'skipped',
        );
      } catch (err) {
        this.logger.warn(
          `The ${locale} text of the draft ${draft.slug} was not stored: ${describe(err)}`,
        );
        this.count('failed');
      }
      await this.pause();
    }

    for (const recipe of own) {
      if (this.job.stopRequested) return;
      const text = await this.translated(
        locale,
        { title: recipe.title, description: recipe.description, steps: recipe.steps },
        recipe.slug,
      );
      if (!text) {
        this.count('failed');
        continue;
      }
      try {
        await this.prisma.recipeDraft.create({
          data: {
            slug: recipe.slug,
            titles: { en: recipe.title, [locale]: text.title },
            descriptions: { en: recipe.description, [locale]: text.description },
            steps: { en: recipe.steps, [locale]: text.steps },
            // English is the recipe's own, and is in the draft for the administrator to pass on: nothing ships without that word.
            locales: ['en', locale],
            servings: recipe.servings,
            mealTypes: recipe.mealTypes,
            dietTags: recipe.dietTags,
            prepMinutes: recipe.prepMinutes,
            cookMinutes: recipe.cookMinutes,
            difficulty: recipe.difficulty,
            cuisine: recipe.cuisine,
            complexity:
              classifyComplexity({
                ingredientCount: recipe.lines.length,
                stepCount: recipe.steps.length,
                totalMinutes: recipe.prepMinutes + recipe.cookMinutes,
              }) ?? 'medium',
            caloriesPerServing: recipe.caloriesPerServing,
            proteinPerServing: recipe.proteinPerServing,
            fatPerServing: recipe.fatPerServing,
            carbsPerServing: recipe.carbsPerServing,
            allergens: recipe.allergens,
            ingredientsJson: recipe.lines,
            batchId,
            modelUsed: this.model.model,
            generatorPrompt: TRANSLATION_PROMPT_VERSION,
          },
        });
        this.count('written');
      } catch (err) {
        this.logger.warn(
          `The draft for the ${locale} text of ${recipe.slug} was not stored: ${describe(err)}`,
        );
        this.count('failed');
      }
      await this.pause();
    }
  }

  /**
   * The recipes of the instance's own library that have no text in `locale`
   * and no draft waiting under their slug, oldest first. A recipe one of
   * whose ingredients has no slug cannot be written as a draft, and is left.
   */
  private async ownRecipesWithout(locale: Locale, most: number) {
    const recipes = await this.prisma.recipe.findMany({
      where: {
        origin: 'curated',
        createdByUserId: null,
        deletedAt: null,
        retiredAt: null,
        slug: { not: null },
        translations: { none: { locale } },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        ingredients: {
          select: {
            quantity: true,
            unit: true,
            note: true,
            ingredient: { select: { slug: true } },
          },
        },
      },
    });
    const drafted = new Set(
      (
        await this.prisma.recipeDraft.findMany({
          where: {
            status: { in: [...WAITING] },
            slug: { in: recipes.map((recipe) => recipe.slug!) },
          },
          select: { slug: true },
        })
      ).map((draft) => draft.slug),
    );
    return recipes
      .filter(
        (recipe) =>
          !drafted.has(recipe.slug!) &&
          recipe.ingredients.every((line) => line.ingredient.slug !== null),
      )
      .slice(0, most)
      .map(({ ingredients, slug, ...recipe }) => ({
        ...recipe,
        slug: slug!,
        lines: ingredients.map((line) => ({
          slug: line.ingredient.slug!,
          quantity: line.quantity,
          unit: line.unit,
          note: line.note,
        })),
      }));
  }

  /** The text of one recipe in `locale`, asked for up to twice; null when no answer was of use. */
  private async translated(
    locale: Locale,
    source: RecipeTextSource,
    slug: string,
  ): Promise<RecipeTextSource | null> {
    const limits = recipeTranslation(source.steps.length, this.model.tuning.temperature);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        const reminder =
          attempt === 0
            ? ''
            : '\nReminder: answer with ONLY the complete JSON object, with exactly as many steps as the English has.';
        const answer = await this.model.ask(
          buildRecipeTranslationPrompt(locale, source) + reminder,
          limits,
        );
        if (answer.truncated) {
          this.logger.warn(
            `The ${locale} text of ${slug} was cut off at ${limits.maxTokens} tokens`,
          );
          continue;
        }
        const checked = validateRecipeTranslation({ source, locale, rawOutput: answer.text });
        if (checked.ok) return checked.text;
        this.logger.warn(
          `The ${locale} text of ${slug} was refused: ${checked.reason}${checked.where ? ` at ${checked.where}` : ''}`,
        );
      } catch (err) {
        this.logger.warn(`The ${locale} text of ${slug} was not answered: ${describe(err)}`);
      }
    }
    return null;
  }

  private count(what: 'written' | 'failed' | 'skipped'): void {
    this.state = {
      ...this.state,
      processed: this.state.processed + 1,
      [what]: this.state[what] + 1,
    };
  }

  /** Wait between two calls where the provider limits how often it is asked, a stop cutting the wait short. */
  private async pause(): Promise<void> {
    const until = Date.now() + this.model.tuning.interBatchDelayMs;
    while (Date.now() < until && !this.job.stopRequested)
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
  }

  private static idle(): TranslationRunnerState {
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
