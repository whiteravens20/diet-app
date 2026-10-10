// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  AiSwapMealRequest,
  SwapMealRequest,
  type DietType,
  type MealPlan,
  type Profile,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FavoriteSetsService } from '../favorite-sets/favorite-sets.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

/** One kind of restriction a profile can set, and a recipe of the fixture that breaks it. */
interface Kind {
  diet: DietType;
  /** Slugs put into the preferences; resolved to ids when the profile is made. */
  allergens: string[];
  excluded: string[];
  favouriteIngredients: string[];
  /** A recipe marked "avoid". */
  avoided: string | null;
  /** The recipe planted on every explicit path, and the meal it is for. */
  violator: string;
  meal: 'lunch' | 'dinner';
  /** Whether a recipe breaks the restriction. */
  breaks(recipe: { slug: string | null; allergens: string[]; ingredients: { ingredient: { slug: string | null; dietCompatibility: string[] } }[] }): boolean;
}

const KINDS: Record<string, Kind> = {
  'the diet of the plan': {
    diet: 'vegan',
    allergens: [],
    excluded: [],
    favouriteIngredients: ['chicken-breast'],
    avoided: null,
    violator: 'chicken-rice-broccoli',
    meal: 'lunch',
    breaks: (recipe) => recipe.ingredients.some((line) => !line.ingredient.dietCompatibility.includes('vegan')),
  },
  'an allergen of the profile': {
    diet: 'balanced',
    allergens: ['peanuts'],
    excluded: [],
    favouriteIngredients: ['peanut-butter'],
    avoided: null,
    violator: 'peanut-tofu-stir-fry',
    meal: 'dinner',
    breaks: (recipe) => recipe.allergens.includes('peanuts'),
  },
  'an ingredient the profile skips': {
    diet: 'balanced',
    allergens: [],
    excluded: ['salmon'],
    favouriteIngredients: ['salmon'],
    avoided: null,
    violator: 'salmon-with-rice',
    meal: 'dinner',
    breaks: (recipe) => recipe.ingredients.some((line) => line.ingredient.slug === 'salmon'),
  },
  'a recipe marked to avoid': {
    diet: 'balanced',
    allergens: [],
    excluded: [],
    favouriteIngredients: ['chickpeas'],
    avoided: 'chickpea-tomato-stew',
    violator: 'chickpea-tomato-stew',
    meal: 'lunch',
    breaks: (recipe) => recipe.slug === 'chickpea-tomato-stew',
  },
};

// One application for the whole file: its settings are read once per process.
let t: TestApp;
let plans: MealPlansService;
let sets: FavoriteSetsService;

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase(t.prisma);
  await seedCatalogue(t.prisma);
  plans = t.app.get(MealPlansService);
  sets = t.app.get(FavoriteSetsService);
});

afterAll(async () => {
  await t.close();
});

describe.each(Object.entries(KINDS))('a plan under %s', (_name, kind) => {
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;
  let violatorId: string;

  const ingredientIds = async (slugs: string[]): Promise<string[]> =>
    (await t.prisma.ingredient.findMany({ where: { slug: { in: slugs } } })).map((row) => row.id);
  const recipeId = async (slug: string): Promise<string> => (await t.prisma.recipe.findUniqueOrThrow({ where: { slug } })).id;

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    user = await aUser(t);
    await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    profile = await aProfile(t, user, {
      dietType: kind.diet,
      preferences: {
        favoriteIngredientIds: await ingredientIds(kind.favouriteIngredients),
        excludedIngredientIds: await ingredientIds(kind.excluded),
        allergens: kind.allergens as never,
        dislikedFoods: [],
        preferredCuisines: [],
        maxConsecutiveDaysSameMeal: 2,
        maxTimesPerWeekSameMeal: 3,
        inventoryBiasResetEvery: 5,
      },
    });
    if (kind.avoided) {
      await t.prisma.favorite.create({
        data: { profileId: profile.id, recipeId: await recipeId(kind.avoided), sentiment: 'avoid' },
      });
    }
    violatorId = await recipeId(kind.violator);
    plan = await aPlan(t, user, profile);
  });

  /** Every recipe in the plan that breaks the restriction, by slug. */
  async function intruders(): Promise<string[]> {
    const meals = await t.prisma.plannedMeal.findMany({
      where: { day: { planId: plan.id }, recipeId: { not: null } },
      include: { recipe: { include: { ingredients: { include: { ingredient: true } } } } },
    });
    expect(meals.length).toBeGreaterThan(0);
    return [...new Set(meals.filter((meal) => kind.breaks(meal.recipe!)).map((meal) => meal.recipe!.slug ?? meal.recipe!.id))];
  }

  const fresh = async (): Promise<MealPlan> => plans.get(user.id, 'en', plan.id);
  const mealOf = async (mealType: string) => (await fresh()).days[0]!.meals.find((m) => m.mealType === mealType)!;
  /** Run an edit that may find nothing to offer; a refusal writes nothing, which is fine here. */
  const attempt = async (edit: () => Promise<unknown>): Promise<boolean> => edit().then(() => true, () => false);

  it('is generated without it', async () => {
    expect(await intruders()).toEqual([]);
  });

  it('stays without it when it is generated again', async () => {
    await plans.regenerate(user.id, 'en', plan.id);
    expect(await intruders()).toEqual([]);
  });

  it('stays without it when one day is changed', async () => {
    for (const day of plan.days.slice(0, 3)) {
      await plans.regenerateDay(user.id, 'en', plan.id, day.id);
    }
    expect(await intruders()).toEqual([]);
  });

  it('stays without it through any number of random swaps', async () => {
    let swapped = 0;
    for (const mealType of ['breakfast', 'lunch', 'dinner']) {
      for (let round = 0; round < 8; round += 1) {
        const meal = await mealOf(mealType);
        if (await attempt(() => plans.swapMeal(user.id, 'en', SwapMealRequest.parse({ planId: plan.id, plannedMealId: meal.id, strategy: 'random' })))) {
          swapped += 1;
        }
      }
    }
    expect(swapped).toBeGreaterThan(0);
    expect(await intruders()).toEqual([]);
  });

  it('stays without it when a swap follows the favourite ingredients, which it is made of', async () => {
    const outcomes: unknown[] = [];
    for (let round = 0; round < 6; round += 1) {
      const meal = await mealOf(kind.meal);
      outcomes.push(
        await plans
          .swapMeal(user.id, 'en', SwapMealRequest.parse({ planId: plan.id, plannedMealId: meal.id, strategy: 'favorite_ingredients' }))
          .then(() => 'swapped', (err: { response?: { error?: string } }) => err.response?.error ?? String(err)),
      );
    }
    // Either another recipe with a favourite ingredient was found, or none is left once the violator is out.
    for (const outcome of outcomes) expect(['swapped', 'NO_FAVORITE_INGREDIENT_MATCH']).toContain(outcome);
    expect(await intruders()).toEqual([]);
  });

  it('stays without it when a model is asked, whether the model names it or answers nonsense', async () => {
    t.model.reply({ text: JSON.stringify({ recipeId: violatorId, reason: 'It looked tasty.' }), times: 4 });
    t.model.reply({ text: 'no idea', times: 4 });
    for (let round = 0; round < 8; round += 1) {
      const meal = await mealOf(kind.meal);
      await plans.aiSwapMeal(user.id, 'en', AiSwapMealRequest.parse({ planId: plan.id, plannedMealId: meal.id }));
    }
    // The model was asked every time, and never shown the recipe.
    expect(t.model.requests).toHaveLength(8);
    for (const request of t.model.requests) expect(request.prompt).not.toContain(`id=${violatorId}`);
    expect(await intruders()).toEqual([]);
  });

  it('refuses it as an explicitly chosen favourite', async () => {
    const meal = await mealOf(kind.meal);

    await expect(
      plans.swapMeal(user.id, 'en', SwapMealRequest.parse({ planId: plan.id, plannedMealId: meal.id, strategy: 'favorite', favoriteRecipeId: violatorId })),
    ).rejects.toMatchObject({ status: 400 });

    expect(await intruders()).toEqual([]);
  });

  it('refuses a favourite set that holds it, and writes nothing of the set', async () => {
    // Saved before the restriction existed, as far as the set knows.
    const other = await recipeId('banana-oat-shake');
    const set = await t.prisma.favoriteSet.create({
      data: { profileId: profile.id, label: 'From before', slots: { [kind.meal]: violatorId, snack: other } },
    });
    const before = await fresh();

    await expect(
      sets.apply(user.id, 'en', set.id, { planId: plan.id, dayDates: [plan.days[1]!.date.slice(0, 10)] }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await intruders()).toEqual([]);
    expect((await fresh()).revision).toBe(before.revision);
  });

  it('refuses to generate a plan that locks it into a day', async () => {
    await expect(
      aPlan(t, user, profile, {
        startDate: '2026-02-02',
        dayOverrides: [{ date: '2026-02-03', lockedSlots: [{ mealType: kind.meal, recipeId: violatorId }] }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
