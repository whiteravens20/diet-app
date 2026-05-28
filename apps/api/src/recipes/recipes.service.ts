import { Injectable, NotFoundException } from '@nestjs/common';
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
        // User-origin recipes (ingredient-substitution variants) are
        // private to their creator — everyone else only sees seed +
        // AI-validated recipes.
        { OR: [{ origin: { not: 'user' } }, { createdByUserId: userId }] },
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
    // Private variants are visible only to their owner; planned-meal recipes
    // are still fetched via /meal-plans which has its own ownership check.
    if (row.origin === 'user' && row.createdByUserId && row.createdByUserId !== userId) {
      throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    }
    return toRecipeDto(row, locale);
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

function pickIngredient(
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
    origin: 'seed' | 'ai' | 'user';
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
