// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The retired ingredients that something of the instance still uses, for the
 * administrator to replace by ingredients of the catalogue. The recipes of the
 * library and the drafts are named by their titles, since their text may name
 * the old food; a recipe of a user's own, a pantry, a profile and a shopping
 * list are only counted.
 */
import type { PrismaClient } from '@prisma/client';
import type { Locale, LocaleStringMap, RetiredIngredient } from '@diet-app/shared';
import { pickIngredient } from '../recipes/recipes.service.js';

export async function retiredIngredientsInUse(
  prisma: PrismaClient,
  locale: Locale,
): Promise<RetiredIngredient[]> {
  const retired = await prisma.ingredient.findMany({
    where: { retiredAt: { not: null } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      retiredAt: true,
      translations: { select: { locale: true, name: true } },
    },
  });
  if (retired.length === 0) return [];
  const ids = retired.map((ingredient) => ingredient.id);

  const [lines, pantry, preferences, rows, drafts] = await Promise.all([
    prisma.recipeIngredient.findMany({
      where: { ingredientId: { in: ids } },
      select: {
        ingredientId: true,
        recipe: {
          select: {
            id: true,
            title: true,
            createdByUserId: true,
            deletedAt: true,
            translations: { where: { locale }, select: { title: true } },
          },
        },
      },
    }),
    prisma.inventoryItem.findMany({
      where: { ingredientId: { in: ids } },
      select: { ingredientId: true },
    }),
    prisma.profilePreference.findMany({
      where: {
        OR: [
          { favoriteIngredientIds: { hasSome: ids } },
          { excludedIngredientIds: { hasSome: ids } },
          { dislikedIngredientIds: { hasSome: ids } },
        ],
      },
      select: {
        favoriteIngredientIds: true,
        excludedIngredientIds: true,
        dislikedIngredientIds: true,
      },
    }),
    prisma.shoppingListItem.findMany({
      where: { ingredientId: { in: ids } },
      select: { ingredientId: true },
    }),
    prisma.recipeDraft.findMany({
      where: { status: { not: 'SHIPPED' } },
      select: { titles: true, ingredientsJson: true },
    }),
  ]);

  return retired
    .map((ingredient): RetiredIngredient => {
      const recipes = new Map(
        lines
          .filter((line) => line.ingredientId === ingredient.id)
          .map((line) => [line.recipe.id, line.recipe]),
      );
      const library = [...recipes.values()].filter((recipe) => recipe.createdByUserId === null);
      const naming = drafts.filter((draft) =>
        (draft.ingredientsJson as unknown as { slug: string }[]).some(
          (line) => line.slug === ingredient.slug,
        ),
      );
      const titleOf = (titles: LocaleStringMap) => titles[locale] ?? titles.en ?? '';
      return {
        id: ingredient.id,
        slug: ingredient.slug,
        name: pickIngredient(locale, ingredient.translations, ingredient.name),
        retiredAt: ingredient.retiredAt!.toISOString(),
        uses: {
          libraryRecipes: library.length,
          ownRecipes: recipes.size - library.length,
          drafts: naming.length,
          pantryRows: pantry.filter((row) => row.ingredientId === ingredient.id).length,
          profiles: preferences.filter((preference) =>
            [
              ...preference.favoriteIngredientIds,
              ...preference.excludedIngredientIds,
              ...preference.dislikedIngredientIds,
            ].includes(ingredient.id),
          ).length,
          shoppingRows: rows.filter((row) => row.ingredientId === ingredient.id).length,
        },
        usedIn: [
          ...library
            .filter((recipe) => recipe.deletedAt === null)
            .map((recipe) => recipe.translations[0]?.title ?? recipe.title),
          ...naming.map((draft) => titleOf(draft.titles as LocaleStringMap)),
        ],
      };
    })
    .filter(({ uses }) => Object.values(uses).some((count) => count > 0));
}
