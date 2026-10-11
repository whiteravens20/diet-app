// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A draft row as the API shows it: whole to the administrator, as the slice
 * of one language to a reviewer.
 */
import type { Prisma } from '@prisma/client';
import type {
  IngredientNameDraft,
  IngredientNameReviewSlice,
  IngredientNameSuggestion,
  Locale,
  LocaleReview,
  PastReview,
  RecipeDraft,
  RecipeDraftIngredientLine,
  RecipeReviewSlice,
} from '@diet-app/shared';

export type RecipeDraftRow = Prisma.RecipeDraftGetPayload<{ include: { localeReviews: true } }>;
export type IngredientNameDraftRow = Prisma.IngredientNameDraftGetPayload<{ include: { localeReviews: true } }>;
type ReviewRow = RecipeDraftRow['localeReviews'][number];

const CANONICAL_LOCALE: Locale = 'en';

/** The reviews a draft's languages have now, in the order of the languages. */
export function currentReviews<T extends { supersededAt: Date | null }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.supersededAt === null);
}

const reviewDto = (row: ReviewRow): LocaleReview => ({
  locale: row.locale as Locale,
  action: row.action as LocaleReview['action'],
  byRole: row.byRole,
  reviewedByLabel: row.reviewedByLabel,
  reason: row.reason,
  reviewedAt: row.reviewedAt.toISOString(),
});

function reviewsOf(rows: readonly ReviewRow[], locales: readonly string[]): { localeReviews: LocaleReview[]; pastReviews: PastReview[] } {
  const byTime = [...rows].sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime());
  return {
    localeReviews: currentReviews(byTime)
      .sort((a, b) => locales.indexOf(a.locale) - locales.indexOf(b.locale))
      .map(reviewDto),
    pastReviews: byTime.filter((row) => row.supersededAt !== null).map((row) => ({ ...reviewDto(row), supersededAt: row.supersededAt!.toISOString() })),
  };
}

export function toRecipeDraftDto(row: RecipeDraftRow): RecipeDraft {
  return {
    id: row.id,
    slug: row.slug,
    titles: row.titles as RecipeDraft['titles'],
    descriptions: row.descriptions as RecipeDraft['descriptions'],
    steps: row.steps as RecipeDraft['steps'],
    locales: row.locales as RecipeDraft['locales'],
    servings: row.servings,
    mealTypes: row.mealTypes as RecipeDraft['mealTypes'],
    dietTags: row.dietTags as RecipeDraft['dietTags'],
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    difficulty: row.difficulty,
    complexity: row.complexity as RecipeDraft['complexity'],
    caloriesPerServing: row.caloriesPerServing,
    proteinPerServing: row.proteinPerServing,
    fatPerServing: row.fatPerServing,
    carbsPerServing: row.carbsPerServing,
    allergens: row.allergens,
    ingredients: row.ingredientsJson as RecipeDraftIngredientLine[],
    status: row.status,
    source: row.source,
    batchId: row.batchId,
    modelUsed: row.modelUsed,
    generatorPrompt: row.generatorPrompt,
    generationSpec: row.generationSpec ?? null,
    provenanceUrl: row.provenanceUrl,
    provenanceLicense: row.provenanceLicense,
    shippedPRUrl: row.shippedPRUrl,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...reviewsOf(row.localeReviews, row.locales),
  };
}

export function toIngredientNameDraftDto(row: IngredientNameDraftRow): IngredientNameDraft {
  return {
    id: row.id,
    ingredientId: row.ingredientId,
    ingredientSlug: row.ingredientSlug,
    rawDescription: row.rawDescription,
    suggestions: row.suggestions as IngredientNameSuggestion,
    locales: row.locales as IngredientNameDraft['locales'],
    status: row.status,
    source: row.source,
    batchId: row.batchId,
    modelUsed: row.modelUsed,
    generatorPrompt: row.generatorPrompt,
    shippedPRUrl: row.shippedPRUrl,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...reviewsOf(row.localeReviews, row.locales),
  };
}

/** A locale-keyed column as a map of strings; anything else in it is left out. */
export function localeMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [locale, value] of Object.entries(raw)) if (typeof value === 'string') out[locale] = value;
  }
  return out;
}

/** A locale-keyed column of step lists. */
export function localeStepsMap(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (raw && typeof raw === 'object') {
    for (const [locale, value] of Object.entries(raw)) if (Array.isArray(value)) out[locale] = value.map(String);
  }
  return out;
}

/** What `locale`'s reviewer has decided about a draft, as it stands now. */
function reviewed(rows: readonly ReviewRow[], locale: Locale): Pick<RecipeReviewSlice, 'alreadyReviewed' | 'alreadyReviewedAction'> {
  const review = currentReviews(rows).find((row) => row.locale === locale);
  return {
    alreadyReviewed: review !== undefined,
    alreadyReviewedAction: review && (review.action === 'APPROVE' || review.action === 'REJECT') ? review.action : null,
  };
}

/** A recipe draft as the reviewer of `locale` sees it: their text, and the English it was written from. */
export function toRecipeReviewSlice(row: RecipeDraftRow, locale: Locale): RecipeReviewSlice {
  const titles = localeMap(row.titles);
  const descriptions = localeMap(row.descriptions);
  const steps = localeStepsMap(row.steps);
  return {
    id: row.id,
    slug: row.slug,
    locale,
    title: titles[locale] ?? '',
    titleSource: titles[CANONICAL_LOCALE] ?? '',
    description: descriptions[locale] ?? '',
    descriptionSource: descriptions[CANONICAL_LOCALE] ?? '',
    steps: steps[locale] ?? [],
    stepsSource: steps[CANONICAL_LOCALE] ?? [],
    servings: row.servings,
    mealTypes: row.mealTypes as RecipeReviewSlice['mealTypes'],
    dietTags: row.dietTags as RecipeReviewSlice['dietTags'],
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    difficulty: row.difficulty,
    complexity: row.complexity as RecipeReviewSlice['complexity'],
    caloriesPerServing: row.caloriesPerServing,
    proteinPerServing: row.proteinPerServing,
    fatPerServing: row.fatPerServing,
    carbsPerServing: row.carbsPerServing,
    allergens: row.allergens,
    ingredients: row.ingredientsJson as RecipeReviewSlice['ingredients'],
    batchId: row.batchId,
    modelUsed: row.modelUsed,
    status: row.status,
    ...reviewed(row.localeReviews, locale),
  };
}

/** An ingredient-name draft as the reviewer of `locale` sees it. */
export function toIngredientNameReviewSlice(row: IngredientNameDraftRow, locale: Locale): IngredientNameReviewSlice {
  const suggestions = (row.suggestions ?? {}) as { name?: Record<string, string>; storageHint?: Record<string, string> };
  return {
    id: row.id,
    ingredientSlug: row.ingredientSlug,
    rawDescription: row.rawDescription,
    locale,
    name: suggestions.name?.[locale] ?? '',
    nameSource: suggestions.name?.[CANONICAL_LOCALE] ?? '',
    storageHint: suggestions.storageHint?.[locale] ?? null,
    storageHintSource: suggestions.storageHint?.[CANONICAL_LOCALE] ?? null,
    batchId: row.batchId,
    modelUsed: row.modelUsed,
    status: row.status,
    ...reviewed(row.localeReviews, locale),
  };
}
