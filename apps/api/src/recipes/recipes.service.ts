// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Cuisine, type Locale, type PlannedIngredient, type Recipe, type RecipeSearchPage, type RecipeSearchQuery } from '@diet-app/shared';
import { collatedFor } from '../common/collation.js';
import { displayAmount, type DisplayedIngredient } from '../engine/display.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { recipesForDiet } from './diet-where.js';

/** What a search of the library is narrowed by: the query of the contract without its paging. */
export type RecipeFilters = Omit<RecipeSearchQuery, 'page' | 'pageSize'>;

const DEFAULT_PAGE_SIZE = 36;
const MAX_PAGE_SIZE = 100;

/** Locale-aware include shape — fetches translation rows for the requested
 *  locale AND the canonical `en` fallback in one query. */
function translationsFor(locale: Locale) {
  const locales = locale === 'en' ? ['en'] : [locale, 'en'];
  return {
    translations: { where: { locale: { in: locales } } },
  } as const;
}

/** Locale-aware search predicate for recipe rows: matches the canonical
 *  English title/description OR the translated title/description for the
 *  request locale. Insensitive on both sides. Exported so other modules
 *  (favorites, future surfaces) can reuse the same rule. */
export function searchMatch(query: string, locale: Locale) {
  const contains = { contains: query, mode: 'insensitive' as const };
  return {
    OR: [
      { title: contains },
      { description: contains },
      { translations: { some: { locale, title: contains } } },
      { translations: { some: { locale, description: contains } } },
    ],
  };
}

/** Read access to the recipe library (seed + AI-validated + user recipes). */
@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    userId: string,
    locale: Locale,
    filters: RecipeFilters,
    paging: { page?: number; pageSize?: number } = {},
  ): Promise<RecipeSearchPage> {
    const pageSize = Math.min(Math.max(paging.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(paging.page ?? 1, 1);
    // What a profile marked and the ingredients it favours are its account's to ask about.
    const profile =
      filters.profileId === undefined
        ? null
        : await this.prisma.profile.findFirst({ where: { id: filters.profileId, userId }, select: { id: true, preferences: { select: { favoriteIngredientIds: true } } } });
    if (filters.profileId !== undefined && !profile) throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    const favoured = profile?.preferences?.favoriteIngredientIds ?? [];
    // Two AND-ed groups: ownership AND the actual filters. We split them
    // because Prisma's top-level `OR` can't co-exist with a second `OR` for
    // the locale-aware search match.
    const where: Prisma.RecipeWhereInput = {
      AND: [
        // Owner-scoped privacy: public recipes (createdByUserId null —
        // seed library + future shared AI library) plus anything the
        // requester owns (user-origin variants + their own AI drafts).
        { OR: [{ createdByUserId: null }, { createdByUserId: userId }] },
        // Soft-deleted user recipes stay referenced by planned meals so
        // history doesn't break, but they never appear in any list query.
        { deletedAt: null },
        { retiredAt: null },
        ...(filters.search ? [searchMatch(filters.search, locale)] : []),
        ...(filters.dietType ? [recipesForDiet(filters.dietType)] : []),
        ...(filters.mealType ? [{ mealTypes: { has: filters.mealType } }] : []),
        ...(filters.maxCalories ? [{ caloriesPerServing: { lte: filters.maxCalories } }] : []),
        ...(filters.maxPrepMinutes ? [{ prepMinutes: { lte: filters.maxPrepMinutes } }] : []),
        ...(filters.difficulty
          ? [{ difficulty: filters.difficulty as 'easy' | 'medium' | 'hard' }]
          : []),
        ...(filters.cuisine ? [{ cuisine: filters.cuisine }] : []),
        // Every ingredient that was named, not any of them: a search for rice and beans is for dishes of both.
        ...(filters.ingredientIds ?? []).map((ingredientId) => ({ ingredients: { some: { ingredientId } } })),
        ...(filters.withoutAllergens?.length ? [{ NOT: { allergens: { hasSome: filters.withoutAllergens } } }] : []),
        ...(filters.minProtein !== undefined ? [{ proteinPerServing: { gte: filters.minProtein } }] : []),
        ...(filters.maxFat !== undefined ? [{ fatPerServing: { lte: filters.maxFat } }] : []),
        ...(filters.maxCarbs !== undefined ? [{ carbsPerServing: { lte: filters.maxCarbs } }] : []),
        ...(filters.marked && profile
          ? [{ favorites: { some: { profileId: profile.id, sentiment: filters.marked === 'marked' ? { in: ['favorite', 'often'] } : filters.marked } } }]
          : []),
        // A profile that favours no ingredient has no recipe with one.
        ...(filters.favoriteIngredients ? [{ ingredients: { some: { ingredientId: { in: favoured } } } }] : []),
      ],
    };
    // The page is cut from the list as it is shown: sorted by the title in the
    // language of the request, or the English one where there is none. Which
    // recipes match is asked first, as ids; the database then puts those in
    // order and hands back one page of them.
    const matching = (await this.prisma.recipe.findMany({ where, select: { id: true } })).map((row) => row.id);
    const total = matching.length;
    const shown =
      total === 0
        ? []
        : await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT r."id" FROM "Recipe" r
            LEFT JOIN "RecipeTranslation" t ON t."recipeId" = r."id" AND t."locale" = ${locale}
            WHERE r."id" = ANY(${matching}::text[])
            ORDER BY COALESCE(t."title", r."title") ${collatedFor(locale)}, r."id"
            LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const rows = await this.prisma.recipe.findMany({
      where: { id: { in: shown.map((row) => row.id) } },
      include: {
        ingredients: { include: { ingredient: { include: translationsFor(locale) } } },
        ...translationsFor(locale),
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      items: shown.flatMap(({ id }) => {
        const row = byId.get(id);
        return row ? [toRecipeDto(row, locale)] : [];
      }),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async get(userId: string, locale: Locale, id: string): Promise<Recipe> {
    const row = await this.prisma.recipe.findUnique({
      where: { id },
      include: {
        ingredients: { include: { ingredient: { include: translationsFor(locale) } } },
        ...translationsFor(locale),
      },
    });
    if (!row) throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    // Owner-scoped privacy: a recipe with an owner is visible only to them.
    // Covers user-origin ingredient variants AND user-private AI drafts.
    // Soft-deleted rows are treated like "not found" for the user; the meal-
    // plan loader has its own path that bypasses this method when it needs
    // historical visibility.
    if (row.createdByUserId && row.createdByUserId !== userId) {
      throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    }
    if (row.deletedAt) {
      throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    }
    return toRecipeDto(row, locale);
  }

  /**
   * List the requester's own non-deleted recipes — backs the "My Recipes" tab.
   * Includes recipes from `/recipes/drafts/from-prompt` (origin = ai), from
   * `/meal-plans/swap-ingredient/apply` (origin = user), and any future user-
   * authored surface. Soft-deleted rows are excluded.
   */
  async listMine(
    userId: string,
    locale: Locale,
    paging: { page?: number; pageSize?: number } = {},
  ): Promise<RecipeSearchPage> {
    const pageSize = Math.min(Math.max(paging.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(paging.page ?? 1, 1);
    const where: Prisma.RecipeWhereInput = {
      createdByUserId: userId,
      deletedAt: null,
    };
    const [total, rows] = await Promise.all([
      this.prisma.recipe.count({ where }),
      this.prisma.recipe.findMany({
        where,
        include: {
          ingredients: { include: { ingredient: { include: translationsFor(locale) } } },
          ...translationsFor(locale),
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map((r) => toRecipeDto(r, locale)),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Soft-delete a user-owned recipe. Marks `deletedAt` so list queries hide
   * the row but planned-meal references stay valid (historical meals don't
   * break). Curated and seed rows can't be deleted by anyone — they're shared
   * infra. Idempotent: re-deleting a row already marked is a no-op.
   */
  async softDeleteMine(userId: string, id: string): Promise<void> {
    const row = await this.prisma.recipe.findUnique({
      where: { id },
      select: { id: true, createdByUserId: true, deletedAt: true, origin: true },
    });
    // Somebody else's own recipe is answered as one that is not there.
    if (!row || (row.createdByUserId !== null && row.createdByUserId !== userId)) {
      throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    }
    // A recipe of the catalogue is everybody's to read and nobody's to delete.
    if (row.createdByUserId === null) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'A recipe of the catalogue cannot be deleted.' });
    }
    if (row.deletedAt) return;
    await this.prisma.recipe.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}

/** Pick the locale-matched translation row with EN fallback. The canonical
 *  English columns (`title`, `description`, `steps`, `name`) are the final
 *  fallback if no translation row exists at all (shouldn't happen post-seed,
 *  but the API must never return blank strings). */
function pickRecipe(
  locale: Locale,
  translations: { locale: string; title: string; description: string; steps: string[] }[] | undefined,
  fallback: { title: string; description: string; steps: string[] },
): { title: string; description: string; steps: string[] } {
  if (!translations || translations.length === 0) return fallback;
  const match = translations.find((t) => t.locale === locale) ?? translations.find((t) => t.locale === 'en');
  return match ?? fallback;
}

export function pickIngredient(
  locale: Locale,
  translations: { locale: string; name: string }[] | undefined,
  fallback: string,
): string {
  if (!translations || translations.length === 0) return fallback;
  const match = translations.find((t) => t.locale === locale) ?? translations.find((t) => t.locale === 'en');
  return match?.name ?? fallback;
}

/** One ingredient line of a recipe row, with what is needed to name and show it. */
export interface RecipeLine {
  ingredientId: string;
  quantity: number;
  unit: 'g' | 'ml' | 'piece';
  note: string | null;
  ingredient: DisplayedIngredient & {
    name: string;
    translations?: { locale: string; name: string }[];
  };
}

/**
 * The lines of a recipe in the amounts one planned meal takes: each scaled by
 * `factor` (the meal's servings over the recipe's), exact and as it is shown.
 */
export function toPlannedIngredients(lines: readonly RecipeLine[], factor: number, locale: Locale): PlannedIngredient[] {
  return lines.map((line) => {
    const quantity = line.quantity * factor;
    return {
      ingredientId: line.ingredientId,
      name: pickIngredient(locale, line.ingredient.translations, line.ingredient.name),
      quantity,
      unit: line.unit,
      display: displayAmount(quantity, line.unit, line.ingredient),
      note: line.note,
    };
  });
}

/** Prisma recipe row (+ ingredients + translations) → shared Recipe contract. */
export function toRecipeDto(
  row: {
    id: string;
    title: string;
    description: string;
    servings: number;
    mealTypes: string[];
    dietTags: string[];
    steps: string[];
    prepMinutes: number;
    cookMinutes: number;
    difficulty: 'easy' | 'medium' | 'hard';
    cuisine: string | null;
    allergens: string[];
    origin: 'seed' | 'ai' | 'user' | 'curated';
    modelAssisted: boolean;
    sourceUrl: string | null;
    sourceLicense: string | null;
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
    translations?: { locale: string; title: string; description: string; steps: string[] }[];
    ingredients: RecipeLine[];
  },
  locale: Locale,
): Recipe {
  const recipeText = pickRecipe(locale, row.translations, {
    title: row.title,
    description: row.description,
    steps: row.steps,
  });
  return {
    id: row.id,
    title: recipeText.title,
    description: recipeText.description,
    servings: row.servings,
    mealTypes: row.mealTypes as Recipe['mealTypes'],
    dietTags: row.dietTags as Recipe['dietTags'],
    ingredients: row.ingredients.map((i) => ({
      ingredientId: i.ingredientId,
      name: pickIngredient(locale, i.ingredient.translations, i.ingredient.name),
      quantity: i.quantity,
      unit: i.unit,
      display: displayAmount(i.quantity, i.unit, i.ingredient),
      note: i.note,
    })),
    steps: recipeText.steps,
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    difficulty: row.difficulty,
    cuisine: Cuisine.safeParse(row.cuisine).data ?? null,
    allergens: row.allergens as Recipe['allergens'],
    nutritionPerServing: {
      calories: row.caloriesPerServing,
      protein: row.proteinPerServing,
      fat: row.fatPerServing,
      carbs: row.carbsPerServing,
    },
    origin: row.origin,
    // A recipe a model wrote says so by its origin; one of the user's that a model had a part in, by its flag.
    byModel: row.origin === 'ai' ? 'written' : row.modelAssisted ? 'changed' : null,
    source: row.sourceLicense === null ? null : { url: row.sourceUrl, license: row.sourceLicense },
  };
}
