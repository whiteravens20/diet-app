// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The curation queue: listing drafts, recording a review, editing a draft and
 * deleting one. The administrator's routes and the reviewers' routes both end
 * here, so that a rule holds for both or for neither.
 *
 * The rules:
 *
 *  - A draft that has shipped is closed: nothing edits, reviews or deletes it.
 *  - A reviewer works on what is waiting or approved. A rejected draft is the
 *    administrator's to reopen; a reviewer can neither read nor change it.
 *  - The administrator reviews any language of a recipe, English above all,
 *    which nobody else may. Reviewers review the other languages. The name
 *    of an ingredient has no English to review.
 *  - A review takes the place of the one its language had; an edit takes the
 *    place of all of them and sends the draft back to be reviewed. What was
 *    decided before stays in the table, marked as superseded.
 *  - Whatever an edit leaves in the draft is held to the rules of every recipe
 *    (`recipes/recipe-rules.ts`). The administrator answers for the whole
 *    draft, a reviewer for the text of the language they edit.
 *  - A status is derived from the reviews that count now (`derive-status.ts`).
 *
 * Every change runs in a transaction that first locks the draft's row. Two
 * people who review two languages at the same moment therefore see each
 * other's review, and there is one current review per language without an
 * index to say so.
 */
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { DraftStatus, Prisma } from '@prisma/client';
import type {
  IngredientNameDraftListQuery,
  IngredientNameReviewPatchBody,
  IngredientNameSuggestion,
  Locale,
  RecipeDraftListQuery,
  RecipeDraftPatch,
  RecipeReviewPatchBody,
  ReviewAction,
  ReviewQueueQuery,
  ReviewerRole,
} from '@diet-app/shared';
import { recipeFacts, type RecipeFacts } from '../../engine/recipe-facts.js';
import { UnitConversionError } from '../../engine/units.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { checkIngredientName, checkRecipe, checkRecipeSlug, checkRecipeText, type RecipeProblem } from '../../recipes/recipe-rules.js';
import { deriveDraftStatus } from './derive-status.js';
import { lockIngredientNameDraft, lockRecipeDraft } from './draft-lock.js';
import { localeMap, localeStepsMap, type IngredientNameDraftRow, type RecipeDraftRow } from './drafts.mapper.js';
import { classifyComplexity } from './recipe-generator.complexity.js';

type Tx = Prisma.TransactionClient;

/** Who is acting: their role, and the name the review is recorded under. */
export interface Actor {
  role: ReviewerRole;
  label: string;
}

export interface Review {
  locale: Locale;
  action: ReviewAction;
  reason?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const WITH_REVIEWS = { localeReviews: true } as const;

/** One ingredient line of a draft, as the engine reads it. */
type RecipeLine = { slug: string; quantity: number; unit: 'g' | 'ml' | 'piece' };

function notFound(): NotFoundException {
  return new NotFoundException({ error: 'DRAFT_NOT_FOUND' });
}

/** The refusal of content that breaks the rules of every recipe: each problem by its place and its rule. */
export function invalid(problems: RecipeProblem[]): BadRequestException {
  return new BadRequestException({
    error: 'DRAFT_INVALID',
    message: `The draft would break ${problems.length === 1 ? 'a rule' : `${problems.length} rules`}: ${problems.map((problem) => problem.message).join('; ')}.`,
    details: { problems },
  });
}

/** Refuse what `by` may not touch in a draft of this status. */
function assertOpen(status: DraftStatus, by: Actor, what: 'edited' | 'reviewed' | 'read' | 'deleted'): void {
  if (status === 'SHIPPED') {
    throw new ConflictException({ error: 'DRAFT_SHIPPED', message: `A draft that has shipped cannot be ${what}.` });
  }
  if (status === 'REJECTED' && by.role === 'REVIEWER') {
    throw new ConflictException({ error: 'DRAFT_REJECTED', message: 'This draft was rejected. Only the administrator can reopen it.' });
  }
}

function assertLocale(locales: readonly string[], locale: Locale): void {
  if (!locales.includes(locale)) {
    throw new BadRequestException({ error: 'LOCALE_NOT_IN_DRAFT', message: `Draft was not generated for locale "${locale}".` });
  }
}

/** True when the patch changes more than text. */
function isStructural(patch: RecipeDraftPatch): boolean {
  return (
    patch.servings !== undefined ||
    patch.mealTypes !== undefined ||
    patch.prepMinutes !== undefined ||
    patch.cookMinutes !== undefined ||
    patch.difficulty !== undefined ||
    patch.ingredients !== undefined
  );
}

@Injectable()
export class DraftService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Reading ────────────────────────────────────────────────────────────────

  async listRecipes(query: RecipeDraftListQuery): Promise<Page<RecipeDraftRow>> {
    const where = { status: query.status, batchId: query.batchId, complexity: query.complexity, source: query.source };
    const [items, total] = await Promise.all([
      this.prisma.recipeDraft.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: WITH_REVIEWS }),
      this.prisma.recipeDraft.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async listIngredientNames(query: IngredientNameDraftListQuery): Promise<Page<IngredientNameDraftRow>> {
    const where = { status: query.status, batchId: query.batchId };
    const [items, total] = await Promise.all([
      this.prisma.ingredientNameDraft.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: WITH_REVIEWS }),
      this.prisma.ingredientNameDraft.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * What waits for the reviewer of one language. A draft that language has
   * approved is left out unless asked for, in the query itself, so that the
   * count and the pages agree.
   */
  private static waitingFor(query: ReviewQueueQuery) {
    return {
      status: { in: ['PENDING', 'APPROVED'] as DraftStatus[] },
      locales: { has: query.locale },
      ...(query.includeReviewed ? {} : { localeReviews: { none: { locale: query.locale, action: 'APPROVE', supersededAt: null } } }),
    };
  }

  async recipesWaitingFor(query: ReviewQueueQuery): Promise<Page<RecipeDraftRow>> {
    const where = DraftService.waitingFor(query);
    const [items, total] = await Promise.all([
      this.prisma.recipeDraft.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: WITH_REVIEWS }),
      this.prisma.recipeDraft.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async ingredientNamesWaitingFor(query: ReviewQueueQuery): Promise<Page<IngredientNameDraftRow>> {
    const where = DraftService.waitingFor(query);
    const [items, total] = await Promise.all([
      this.prisma.ingredientNameDraft.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: WITH_REVIEWS }),
      this.prisma.ingredientNameDraft.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async recipe(id: string): Promise<RecipeDraftRow> {
    const row = await this.prisma.recipeDraft.findUnique({ where: { id }, include: WITH_REVIEWS });
    if (!row) throw notFound();
    return row;
  }

  async ingredientName(id: string): Promise<IngredientNameDraftRow> {
    const row = await this.prisma.ingredientNameDraft.findUnique({ where: { id }, include: WITH_REVIEWS });
    if (!row) throw notFound();
    return row;
  }

  /** A recipe draft for the reviewer of `locale`: one they may work on, in a language it has. */
  async recipeFor(id: string, locale: Locale, by: Actor): Promise<RecipeDraftRow> {
    const row = await this.recipe(id);
    assertOpen(row.status, by, 'read');
    assertLocale(row.locales, locale);
    return row;
  }

  async ingredientNameFor(id: string, locale: Locale, by: Actor): Promise<IngredientNameDraftRow> {
    const row = await this.ingredientName(id);
    assertOpen(row.status, by, 'read');
    assertLocale(row.locales, locale);
    return row;
  }

  // ── Reviews ────────────────────────────────────────────────────────────────

  reviewRecipe(id: string, review: Review, by: Actor): Promise<RecipeDraftRow> {
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockRecipe(tx, id);
      assertOpen(draft.status, by, 'reviewed');
      assertLocale(draft.locales, review.locale);

      const at = new Date();
      await tx.recipeDraftLocaleReview.updateMany({ where: { draftId: id, locale: review.locale, supersededAt: null }, data: { supersededAt: at } });
      await tx.recipeDraftLocaleReview.create({
        data: { draftId: id, locale: review.locale, action: review.action, byRole: by.role, reviewedByLabel: by.label, reason: review.reason ?? null, reviewedAt: at },
      });
      const current = await tx.recipeDraftLocaleReview.findMany({ where: { draftId: id, supersededAt: null } });
      return tx.recipeDraft.update({ where: { id }, data: { status: deriveDraftStatus(draft.locales, current) }, include: WITH_REVIEWS });
    });
  }

  reviewIngredientName(id: string, review: Review, by: Actor): Promise<IngredientNameDraftRow> {
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockIngredientName(tx, id);
      assertOpen(draft.status, by, 'reviewed');
      assertLocale(draft.locales, review.locale);

      const at = new Date();
      await tx.ingredientNameDraftLocaleReview.updateMany({ where: { draftId: id, locale: review.locale, supersededAt: null }, data: { supersededAt: at } });
      await tx.ingredientNameDraftLocaleReview.create({
        data: { draftId: id, locale: review.locale, action: review.action, byRole: by.role, reviewedByLabel: by.label, reason: review.reason ?? null, reviewedAt: at },
      });
      const current = await tx.ingredientNameDraftLocaleReview.findMany({ where: { draftId: id, supersededAt: null } });
      return tx.ingredientNameDraft.update({ where: { id }, data: { status: deriveDraftStatus(draft.locales, current) }, include: WITH_REVIEWS });
    });
  }

  /**
   * The administrator rejects several recipe drafts at once, with one reason.
   * Each is rejected on its own, as a single rejection is, so one that has
   * shipped or is gone in the meantime is left out and named, and the others
   * are rejected all the same.
   */
  async rejectRecipes(ids: readonly string[], reason: string | undefined, by: Actor): Promise<{ rejected: string[]; skipped: { id: string; error: string }[] }> {
    const rejected: string[] = [];
    const skipped: { id: string; error: string }[] = [];
    for (const id of new Set(ids)) {
      try {
        // English is the language every recipe draft has, and the administrator's to review.
        await this.reviewRecipe(id, { locale: 'en', action: 'REJECT', reason }, by);
        rejected.push(id);
      } catch (err) {
        if (!(err instanceof HttpException)) throw err;
        const body = err.getResponse();
        skipped.push({ id, error: typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : err.message });
      }
    }
    return { rejected, skipped };
  }

  // ── Edits ──────────────────────────────────────────────────────────────────

  /**
   * The administrator's edit of a recipe draft. What the patch sends is laid
   * over the draft, text language by language, and the result is checked as a
   * whole. With `dryRun` the result is returned and nothing is stored.
   *
   * A draft that stands for recipes users made takes changes to its text
   * and its slug only: its ingredients are theirs, and it is recognised by
   * them. For such a draft the figures are worked out again all the same, so
   * that it can be approved with what the catalogue says today.
   *
   * A patch that changes the slug and nothing else leaves the reviews
   * standing: the slug is no part of what a reviewer approved.
   */
  editRecipe(id: string, patch: RecipeDraftPatch, by: Actor, options: { dryRun?: boolean } = {}): Promise<RecipeDraftRow> {
    return this.prisma.$transaction(async (tx) => {
      const draft = options.dryRun ? await tx.recipeDraft.findUnique({ where: { id }, include: WITH_REVIEWS }) : await this.lockRecipe(tx, id);
      if (!draft) throw notFound();
      assertOpen(draft.status, by, 'edited');
      const fromUsers = draft.source === 'AI_USER';
      if (fromUsers && isStructural(patch)) {
        throw new ForbiddenException({ error: 'DRAFT_STRUCTURAL_EDIT_FORBIDDEN', message: 'User-drafted recipes: translation edits only.' });
      }

      const { slug: renamed, cuisine: tagged, ...changes } = patch;
      let slug = draft.slug;
      if (renamed !== undefined) {
        const checked = checkRecipeSlug(renamed);
        if (!checked.ok) throw invalid(checked.problems);
        slug = checked.slug;
      }
      // The name the recipe ships under and the cuisine it is tagged with are no part of what the reviewers approved.
      const cuisine = tagged === undefined ? draft.cuisine : tagged;
      if ((renamed !== undefined || tagged !== undefined) && Object.values(changes).every((value) => value === undefined)) {
        return options.dryRun ? { ...draft, slug, cuisine } : tx.recipeDraft.update({ where: { id }, data: { slug, cuisine }, include: WITH_REVIEWS });
      }

      const text = {
        titles: { ...localeMap(draft.titles), ...patch.titles },
        descriptions: { ...localeMap(draft.descriptions), ...patch.descriptions },
        steps: { ...localeStepsMap(draft.steps), ...patch.steps },
      };
      let data;
      if (fromUsers) {
        // The administrator answers for the text; the rest is the users' own
        // rows, with the figures the engine gave them.
        const checked = checkRecipeText(text, draft.locales);
        if (!checked.ok) throw invalid(checked.problems);
        data = { ...checked.text, slug, cuisine, ...(await this.factsOf(tx, draft.ingredientsJson as RecipeLine[], draft.servings)) };
      } else {
        const checked = checkRecipe(
          {
            ...text,
            servings: patch.servings ?? draft.servings,
            mealTypes: patch.mealTypes ?? draft.mealTypes,
            prepMinutes: patch.prepMinutes ?? draft.prepMinutes,
            cookMinutes: patch.cookMinutes ?? draft.cookMinutes,
            difficulty: patch.difficulty ?? draft.difficulty,
            ingredients: patch.ingredients ?? draft.ingredientsJson,
          },
          draft.locales,
        );
        if (!checked.ok) throw invalid(checked.problems);
        const recipe = checked.recipe;
        data = {
          slug,
          cuisine,
          titles: recipe.titles,
          descriptions: recipe.descriptions,
          steps: recipe.steps,
          servings: recipe.servings,
          mealTypes: recipe.mealTypes,
          prepMinutes: recipe.prepMinutes,
          cookMinutes: recipe.cookMinutes,
          difficulty: recipe.difficulty,
          ingredientsJson: recipe.ingredients,
          // Worked out again from today's ingredient table.
          ...(await this.derive(tx, recipe)),
        };
      }
      if (options.dryRun) return { ...draft, ...data };

      await tx.recipeDraftLocaleReview.updateMany({ where: { draftId: id, supersededAt: null }, data: { supersededAt: new Date() } });
      return tx.recipeDraft.update({ where: { id }, data: { ...data, status: 'PENDING' }, include: WITH_REVIEWS });
    });
  }

  /** A reviewer's edit: the text of their language, and nothing else of the draft. */
  editRecipeText(id: string, locale: Locale, patch: RecipeReviewPatchBody, by: Actor): Promise<RecipeDraftRow> {
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockRecipe(tx, id);
      assertOpen(draft.status, by, 'edited');
      assertLocale(draft.locales, locale);

      const titles = localeMap(draft.titles);
      const descriptions = localeMap(draft.descriptions);
      const steps = localeStepsMap(draft.steps);
      const checked = checkRecipeText(
        {
          titles: { [locale]: patch.title ?? titles[locale] },
          descriptions: { [locale]: patch.description ?? descriptions[locale] },
          steps: { [locale]: patch.steps ?? steps[locale] },
        },
        [locale],
      );
      if (!checked.ok) throw invalid(checked.problems);

      await tx.recipeDraftLocaleReview.updateMany({ where: { draftId: id, supersededAt: null }, data: { supersededAt: new Date() } });
      return tx.recipeDraft.update({
        where: { id },
        data: {
          titles: { ...titles, ...checked.text.titles },
          descriptions: { ...descriptions, ...checked.text.descriptions },
          steps: { ...steps, ...checked.text.steps },
          status: 'PENDING',
        },
        include: WITH_REVIEWS,
      });
    });
  }

  /**
   * The administrator's edit of an ingredient-name draft. Only the languages
   * of the draft are kept: a name in any other would ship without anybody
   * having been asked to approve it.
   */
  editIngredientName(id: string, suggestions: IngredientNameSuggestion, by: Actor): Promise<IngredientNameDraftRow> {
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockIngredientName(tx, id);
      assertOpen(draft.status, by, 'edited');

      const checked = checkIngredientName(suggestions, draft.locales);
      if (!checked.ok) throw invalid(checked.problems);

      await tx.ingredientNameDraftLocaleReview.updateMany({ where: { draftId: id, supersededAt: null }, data: { supersededAt: new Date() } });
      return tx.ingredientNameDraft.update({ where: { id }, data: { suggestions: checked.suggestion, status: 'PENDING' }, include: WITH_REVIEWS });
    });
  }

  /** A reviewer's edit of the name in their language. An empty storage hint takes the hint away. */
  editIngredientNameText(id: string, locale: Locale, patch: IngredientNameReviewPatchBody, by: Actor): Promise<IngredientNameDraftRow> {
    return this.prisma.$transaction(async (tx) => {
      const draft = await this.lockIngredientName(tx, id);
      assertOpen(draft.status, by, 'edited');
      assertLocale(draft.locales, locale);

      const stored = (draft.suggestions ?? {}) as { name?: Record<string, string>; storageHint?: Record<string, string> };
      const checked = checkIngredientName(
        {
          name: { [locale]: patch.name ?? stored.name?.[locale] },
          storageHint: { [locale]: patch.storageHint ?? stored.storageHint?.[locale] },
        },
        [locale],
      );
      if (!checked.ok) throw invalid(checked.problems);

      const name = { ...stored.name, ...checked.suggestion.name };
      const storageHint = { ...stored.storageHint };
      delete storageHint[locale];
      Object.assign(storageHint, checked.suggestion.storageHint);

      await tx.ingredientNameDraftLocaleReview.updateMany({ where: { draftId: id, supersededAt: null }, data: { supersededAt: new Date() } });
      return tx.ingredientNameDraft.update({
        where: { id },
        data: { suggestions: { name, ...(Object.keys(storageHint).length > 0 ? { storageHint } : {}) }, status: 'PENDING' },
        include: WITH_REVIEWS,
      });
    });
  }

  // ── Deleting ───────────────────────────────────────────────────────────────

  async deleteRecipe(id: string, by: Actor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const draft = await this.lockRecipe(tx, id);
      assertOpen(draft.status, by, 'deleted');
      await tx.recipeDraft.delete({ where: { id } });
    });
  }

  async deleteIngredientName(id: string, by: Actor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const draft = await this.lockIngredientName(tx, id);
      assertOpen(draft.status, by, 'deleted');
      await tx.ingredientNameDraft.delete({ where: { id } });
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** The draft, with its row locked until the transaction ends. */
  private async lockRecipe(tx: Tx, id: string): Promise<RecipeDraftRow> {
    await lockRecipeDraft(tx, id);
    const draft = await tx.recipeDraft.findUnique({ where: { id }, include: WITH_REVIEWS });
    if (!draft) throw notFound();
    return draft;
  }

  private async lockIngredientName(tx: Tx, id: string): Promise<IngredientNameDraftRow> {
    await lockIngredientNameDraft(tx, id);
    const draft = await tx.ingredientNameDraft.findUnique({ where: { id }, include: WITH_REVIEWS });
    if (!draft) throw notFound();
    return draft;
  }

  /** What the engine makes of a recipe's ingredients, and the band of generated recipes it falls into. */
  private async derive(tx: Tx, recipe: { ingredients: RecipeLine[]; servings: number; steps: Record<string, string[]>; prepMinutes: number; cookMinutes: number }) {
    const facts = await this.factsOf(tx, recipe.ingredients, recipe.servings);

    const stepCount = recipe.steps.en?.length ?? Object.values(recipe.steps)[0]?.length ?? 0;
    const totalMinutes = recipe.prepMinutes + recipe.cookMinutes;
    const complexity = classifyComplexity({ ingredientCount: recipe.ingredients.length, stepCount, totalMinutes });
    if (complexity === null) {
      throw new BadRequestException({
        error: 'OUT_OF_COMPLEXITY_BAND',
        message: `recipe is outside every complexity band (ingredients=${recipe.ingredients.length}, steps=${stepCount}, minutes=${totalMinutes})`,
      });
    }
    return { complexity, ...facts };
  }

  /** The figures of a draft: what the engine makes of its ingredients with today's ingredient table. */
  private async factsOf(tx: Tx, ingredients: RecipeLine[], servings: number) {
    const rows = await tx.ingredient.findMany({
      where: { slug: { in: [...new Set(ingredients.map((line) => line.slug))] } },
      select: {
        slug: true,
        canonicalUnit: true,
        gramsPerPiece: true,
        density: true,
        caloriesPer100: true,
        proteinPer100: true,
        fatPer100: true,
        carbsPer100: true,
        allergens: true,
        dietCompatibility: true,
      },
    });
    const bySlug = new Map(rows.map((row) => [row.slug!, row]));
    const lines = ingredients.map((line) => {
      const ingredient = bySlug.get(line.slug);
      if (!ingredient) {
        throw new BadRequestException({ error: 'UNKNOWN_SLUG', message: `ingredient slug "${line.slug}" not found in the curated catalogue` });
      }
      return { quantity: line.quantity, unit: line.unit, ingredient };
    });
    let facts: RecipeFacts;
    try {
      facts = recipeFacts(lines, servings);
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      throw new BadRequestException({ error: 'UNIT_CONVERSION_FAILED', message: err.message });
    }
    return {
      dietTags: facts.dietTags,
      allergens: facts.allergens,
      caloriesPerServing: facts.perServing.calories,
      proteinPerServing: facts.perServing.protein,
      fatPerServing: facts.perServing.fat,
      carbsPerServing: facts.perServing.carbs,
    };
  }
}
