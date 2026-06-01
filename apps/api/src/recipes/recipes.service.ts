import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Locale, Recipe, RecipeSearchPage } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RecipeFilters {
  search?: string;
  dietType?: string;
  mealType?: string;
  maxCalories?: number;
  maxPrepMinutes?: number;
  difficulty?: string;
}

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
        ...(filters.search ? [searchMatch(filters.search, locale)] : []),
        ...(filters.dietType ? [{ dietTags: { has: filters.dietType } }] : []),
        ...(filters.mealType ? [{ mealTypes: { has: filters.mealType } }] : []),
        ...(filters.maxCalories ? [{ caloriesPerServing: { lte: filters.maxCalories } }] : []),
        ...(filters.maxPrepMinutes ? [{ prepMinutes: { lte: filters.maxPrepMinutes } }] : []),
        ...(filters.difficulty
          ? [{ difficulty: filters.difficulty as 'easy' | 'medium' | 'hard' }]
          : []),
      ],
    };
    // Total + page in parallel — both queries cost roughly the same; doing
    // them sequentially would double the latency for no benefit.
    const [total, rows] = await Promise.all([
      this.prisma.recipe.count({ where }),
      this.prisma.recipe.findMany({
        where,
        include: {
          ingredients: { include: { ingredient: { include: translationsFor(locale) } } },
          ...translationsFor(locale),
        },
        orderBy: { title: 'asc' },
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
    if (!row) {
      throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    }
    if (row.createdByUserId !== userId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Only the owner can delete a recipe.',
      });
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
    allergens: string[];
    origin: 'seed' | 'ai' | 'user' | 'curated';
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
    reuseScore: number;
    translations?: { locale: string; title: string; description: string; steps: string[] }[];
    ingredients: {
      ingredientId: string;
      quantity: number;
      unit: 'g' | 'ml' | 'piece';
      note: string | null;
      ingredient: {
        name: string;
        gramsPerPiece: number | null;
        translations?: { locale: string; name: string }[];
      };
    }[];
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
      gramsPerPiece: i.ingredient.gramsPerPiece,
      note: i.note,
    })),
    steps: recipeText.steps,
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    difficulty: row.difficulty,
    allergens: row.allergens as Recipe['allergens'],
    nutritionPerServing: {
      calories: row.caloriesPerServing,
      protein: row.proteinPerServing,
      fat: row.fatPerServing,
      carbs: row.carbsPerServing,
    },
    reuseScore: row.reuseScore,
    origin: row.origin,
  };
}
