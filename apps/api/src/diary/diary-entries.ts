// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { LabelNutrient, type DiaryEntry, type Locale, type MealType } from '@diet-app/shared';
import { isoDate } from '../meal-plans/plan-days.js';
import { pickIngredient, pickTitle } from '../recipes/recipes.service.js';
import { wholeFigures } from './diary-days.js';

/** The languages a name is read in: the reader's, and English where it has none in it. */
export const languages = (locale: Locale): string[] => (locale === 'en' ? ['en'] : [locale, 'en']);

/** What an entry is read with: the recipe or the ingredient it is of, named in the reader's language. */
export const entryWith = (locale: Locale) =>
  ({
    recipe: {
      select: {
        title: true,
        deletedAt: true,
        translations: {
          where: { locale: { in: languages(locale) } },
          select: { locale: true, title: true },
        },
      },
    },
    ingredient: {
      select: {
        name: true,
        displayUnit: true,
        translations: {
          where: { locale: { in: languages(locale) } },
          select: { locale: true, name: true },
        },
      },
    },
    product: { select: { code: true } },
    ownProduct: { select: { code: true } },
  }) satisfies Prisma.DiaryEntryInclude;
export type EntryRow = Prisma.DiaryEntryGetPayload<{ include: ReturnType<typeof entryWith> }>;

/** An entry as the diary, and a plan's day, show it. */
export function entryDto(row: EntryRow, locale: Locale): DiaryEntry {
  // A recipe its owner deleted is gone for the diary, as it is for the library.
  const recipe = row.recipe?.deletedAt === null ? row.recipe : null;
  const name = recipe
    ? pickTitle(locale, recipe.translations, recipe.title)
    : row.ingredient
      ? pickIngredient(locale, row.ingredient.translations, row.ingredient.name)
      : row.name;
  return {
    id: row.id,
    profileId: row.profileId,
    date: isoDate(row.date),
    mealType: row.mealType as MealType,
    kind: row.kind,
    name,
    recipeId: recipe ? row.recipeId : null,
    ingredientId: row.ingredientId,
    productId: row.productId ?? row.ownProductId,
    productCode: row.product?.code ?? row.ownProduct?.code ?? null,
    productSource: row.productSource,
    servings: row.servings,
    amount:
      row.quantity !== null && row.unit !== null
        ? {
            quantity: row.quantity,
            unit: row.unit,
            // What was written is what was eaten: nothing rounds it, and a piece goes by the ingredient's word for it.
            shown: {
              quantity: row.quantity,
              unit: row.unit === 'piece' ? (row.ingredient?.displayUnit ?? 'piece') : row.unit,
            },
          }
        : null,
    nutrition: wholeFigures(row),
    // A product says what its label says, nothing as well; another kind, where something is known.
    label:
      row.kind === 'product' ||
      [row.fiber, row.sugars, row.salt, row.saturatedFat].some((grams) => grams !== null)
        ? {
            fiber: tenths(row.fiber),
            sugars: tenths(row.sugars),
            salt: tenths(row.salt),
            saturatedFat: tenths(row.saturatedFat),
          }
        : null,
    labelAtLeast: row.labelAtLeast.filter(
      (nutrient): nutrient is LabelNutrient => LabelNutrient.safeParse(nutrient).success,
    ),
    estimated: row.estimated,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A figure of a label as a person reads it: a grain of salt is told by its tenth. */
const tenths = (grams: number | null): number | null =>
  grams === null ? null : Math.round(grams * 10) / 10;

/**
 * The entries of a profile's diary on the days of a plan, by date, the first
 * written first: one statement for all of them. Nothing is asked for a plan
 * without days.
 */
export async function entriesOfDays(
  db: Pick<Prisma.TransactionClient, 'diaryEntry'>,
  locale: Locale,
  profileId: string,
  days: readonly { date: Date }[],
): Promise<Map<string, DiaryEntry[]>> {
  const byDate = new Map<string, DiaryEntry[]>();
  if (days.length === 0) return byDate;
  const rows = await db.diaryEntry.findMany({
    where: { profileId, date: { gte: days[0]!.date, lte: days.at(-1)!.date } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: entryWith(locale),
  });
  for (const row of rows) {
    const date = isoDate(row.date);
    byDate.set(date, [...(byDate.get(date) ?? []), entryDto(row, locale)]);
  }
  return byDate;
}
