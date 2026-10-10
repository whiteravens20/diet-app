// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  AiSuggestIngredientRequest,
  AiSwapMealRequest,
  SwapMealRequest,
  type MealPlan,
  type Profile,
} from '@diet-app/shared';
import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FavoriteSetsService } from '../favorite-sets/favorite-sets.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

let t: TestApp;
let plans: MealPlansService;
let sets: FavoriteSetsService;
let user: TestUser;
let profile: Profile;
let plan: MealPlan;

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

beforeEach(async () => {
  await resetUserData(t.prisma);
  t.model.reset();
  user = await aUser(t);
  profile = await aProfile(t, user);
  plan = await aPlan(t, user, profile);
});

/** The status and code a refused call answered with. */
async function refusal(call: Promise<unknown>): Promise<{ status: number; error: string }> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const body = (err as HttpException).getResponse() as { error: string };
    return { status: (err as HttpException).getStatus(), error: body.error };
  }
  throw new Error('the call was expected to be refused');
}

const recipeId = async (slug: string): Promise<string> => (await t.prisma.recipe.findUniqueOrThrow({ where: { slug } })).id;
const mealRow = (id: string) => t.prisma.plannedMeal.findUniqueOrThrow({ where: { id } });
const randomSwap = (plannedMealId: string) =>
  plans.swapMeal(user.id, 'en', SwapMealRequest.parse({ planId: plan.id, plannedMealId, strategy: 'random' }));

describe('a meal that was eaten', () => {
  it('cannot be swapped, re-picked by a model or have an ingredient substituted, and stays as it was', async () => {
    const meal = plan.days[0]!.meals[0]!;
    await plans.setEaten(user.id, 'en', plan.id, meal.id, true);
    const line = meal.recipe!.ingredients[0]!;
    const before = await mealRow(meal.id);

    const eaten = { status: 409, error: 'MEAL_EATEN' };
    expect(await refusal(randomSwap(meal.id))).toEqual(eaten);
    expect(
      await refusal(plans.aiSwapMeal(user.id, 'en', AiSwapMealRequest.parse({ planId: plan.id, plannedMealId: meal.id }))),
    ).toEqual(eaten);
    expect(
      await refusal(
        plans.aiSuggestIngredient(
          user.id,
          'en',
          AiSuggestIngredientRequest.parse({ planId: plan.id, plannedMealId: meal.id, fromIngredientId: line.ingredientId }),
        ),
      ),
    ).toEqual(eaten);
    expect(
      await refusal(
        plans.applyIngredientSwap(user.id, 'en', {
          planId: plan.id,
          plannedMealId: meal.id,
          fromIngredientId: line.ingredientId,
          toIngredientId: line.ingredientId,
        }),
      ),
    ).toEqual(eaten);

    const after = await mealRow(meal.id);
    expect(after.recipeId).toBe(before.recipeId);
    expect(after.eatenAt).toEqual(before.eatenAt);
    // The model was never asked about a meal that cannot change.
    expect(t.model.requests).toHaveLength(0);
  });

  it('can be swapped again once it is unmarked', async () => {
    const meal = plan.days[0]!.meals[0]!;
    await plans.setEaten(user.id, 'en', plan.id, meal.id, true);
    await plans.setEaten(user.id, 'en', plan.id, meal.id, false);

    await randomSwap(meal.id);

    expect((await mealRow(meal.id)).recipeId).not.toBe(meal.recipe!.id);
  });

  it('is not written over by a favourite set', async () => {
    const meal = plan.days[0]!.meals.find((m) => m.mealType === 'breakfast')!;
    await plans.setEaten(user.id, 'en', plan.id, meal.id, true);
    const set = await sets.create(user.id, {
      profileId: profile.id,
      label: 'Morning',
      slots: { breakfast: await recipeId('tofu-scramble') },
    });

    expect(
      await refusal(sets.apply(user.id, 'en', set.id, { planId: plan.id, dayDates: [plan.days[0]!.date.slice(0, 10)] })),
    ).toEqual({ status: 409, error: 'MEAL_EATEN' });
    expect((await mealRow(meal.id)).recipeId).toBe(meal.recipe!.id);
  });
});

describe('a custom meal', () => {
  const addCustom = async () => {
    const result = await plans.addCustomMeal(user.id, 'en', plan.id, plan.days[0]!.date.slice(0, 10), {
      name: "Mum's lasagne",
      mealType: 'snack',
      nutrition: { calories: 420, protein: 20, fat: 18, carbs: 40 },
      servings: 1,
    });
    return result.plan.days[0]!.meals.find((m) => m.customName === "Mum's lasagne")!;
  };

  it('cannot be swapped on any path', async () => {
    const custom = await addCustom();

    const refused = { status: 400, error: 'CUSTOM_MEAL_NOT_SWAPPABLE' };
    expect(await refusal(randomSwap(custom.id))).toEqual(refused);
    expect(
      await refusal(plans.aiSwapMeal(user.id, 'en', AiSwapMealRequest.parse({ planId: plan.id, plannedMealId: custom.id }))),
    ).toEqual(refused);
    expect((await mealRow(custom.id)).customName).toBe("Mum's lasagne");
  });

  it('is replaced completely when a favourite set fills its slot, and the day is rebalanced', async () => {
    const custom = await addCustom();
    const shake = await recipeId('banana-oat-shake');
    const set = await sets.create(user.id, { profileId: profile.id, label: 'Snack', slots: { snack: shake } });

    const after = await sets.apply(user.id, 'en', set.id, { planId: plan.id, dayDates: [plan.days[0]!.date.slice(0, 10)] });

    const row = await mealRow(custom.id);
    expect(row).toMatchObject({ recipeId: shake, source: 'CATALOGUE', customName: null, customMacros: null });
    const meal = after.days[0]!.meals.find((m) => m.id === custom.id)!;
    expect(meal.recipe!.id).toBe(shake);
    expect(meal.customName).toBeNull();
    // Rebalanced: the day's planned energy is back near its target.
    const day = after.days[0]!;
    const planned = day.meals.reduce((sum, m) => sum + m.nutrition.calories, 0);
    expect(Math.abs(planned - day.calorieTarget) / day.calorieTarget).toBeLessThan(0.15);
  });
});

describe('a favourite set applied over a rebalanced meal', () => {
  it('starts the replaced meal from a scale of one', async () => {
    const meal = plan.days[0]!.meals.find((m) => m.mealType === 'dinner')!;
    await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { quantityScale: 1.6 } });
    const stew = await recipeId('chickpea-tomato-stew');
    const set = await sets.create(user.id, { profileId: profile.id, label: 'Dinner', slots: { dinner: stew } });

    await sets.apply(user.id, 'en', set.id, { planId: plan.id, dayDates: [plan.days[0]!.date.slice(0, 10)] });

    const row = await mealRow(meal.id);
    expect(row.recipeId).toBe(stew);
    // Whatever the rebalancer then chose, it started from the new recipe, not from 1.6 of the old one.
    expect(row.quantityScale).toBeGreaterThan(0);
    expect(row.quantityScale).not.toBe(1.6);
    expect(row.swapHistory).toEqual([stew]);
  });
});

describe('a plan on a custom diet', () => {
  beforeEach(async () => {
    profile = await aProfile(t, user, { name: 'Custom', dietType: 'custom' });
    plan = await aPlan(t, user, profile);
    expect(plan.dietType).toBe('custom');
  });

  it('can have a meal swapped: the diet filters nothing', async () => {
    const meal = plan.days[0]!.meals[0]!;

    await randomSwap(meal.id);

    expect((await mealRow(meal.id)).recipeId).not.toBe(meal.recipe!.id);
  });

  it('can have a model pick a meal and suggest an ingredient', async () => {
    await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    const meal = plan.days[0]!.meals[0]!;

    const swapped = await plans.aiSwapMeal(user.id, 'en', AiSwapMealRequest.parse({ planId: plan.id, plannedMealId: meal.id }));
    expect(swapped.plan.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).not.toBe(meal.recipe!.id);

    // Any ingredient of a category with more than one member has a substitute on offer.
    const fresh = await plans.get(user.id, 'en', plan.id);
    let suggested = 0;
    for (const m of fresh.days.flatMap((day) => day.meals)) {
      for (const line of m.recipe?.ingredients ?? []) {
        const ingredient = await t.prisma.ingredient.findUniqueOrThrow({ where: { id: line.ingredientId } });
        if (!['grains', 'vegetables', 'legumes'].includes(ingredient.category)) continue;
        const result = await plans.aiSuggestIngredient(
          user.id,
          'en',
          AiSuggestIngredientRequest.parse({ planId: plan.id, plannedMealId: m.id, fromIngredientId: line.ingredientId }),
        );
        expect(result.toIngredient.id).toBeTruthy();
        suggested += 1;
        break;
      }
      if (suggested > 0) break;
    }
    expect(suggested).toBe(1);
  });

  it('does not flag its meals as off-diet', async () => {
    expect(plan.days.flatMap((day) => day.meals).some((meal) => meal.dietOverride)).toBe(false);
  });
});

describe('a planned meal the profile has since ruled out', () => {
  const conflictsOf = async (mealId: string) =>
    (await plans.get(user.id, 'en', plan.id)).days.flatMap((day) => day.meals).find((meal) => meal.id === mealId)!.restrictionConflicts;

  it('stays in the plan and says what rules it out', async () => {
    const meals = plan.days.flatMap((day) => day.meals);
    const meal = meals.find((m) => (m.recipe?.allergens.length ?? 0) > 0)!;
    const allergen = meal.recipe!.allergens[0]!;
    const skipped = meal.recipe!.ingredients[0]!.ingredientId;
    // A meal the new rules have nothing to do with.
    const bystander = meals.find(
      (m) =>
        m.recipe!.id !== meal.recipe!.id &&
        !m.recipe!.allergens.includes(allergen) &&
        !m.recipe!.ingredients.some((line) => line.ingredientId === skipped),
    )!;
    expect(await conflictsOf(meal.id)).toEqual([]);

    await t.prisma.profilePreference.upsert({
      where: { profileId: profile.id },
      update: { allergens: [allergen], excludedIngredientIds: [skipped] },
      create: { profileId: profile.id, allergens: [allergen], excludedIngredientIds: [skipped] },
    });
    await t.prisma.favorite.create({ data: { profileId: profile.id, recipeId: meal.recipe!.id, sentiment: 'avoid' } });

    expect(await conflictsOf(meal.id)).toEqual(['allergen', 'excluded_ingredient', 'avoided']);
    expect(await conflictsOf(bystander.id)).toEqual([]);
    // The meal itself was not touched.
    expect((await mealRow(meal.id)).recipeId).toBe(meal.recipe!.id);
  });
});

describe('a lock on a recipe that may no longer enter the plan', () => {
  const START = '2026-03-02';
  const LOCKED_DAY = '2026-03-03';
  let locked: string;
  let lockedPlan: MealPlan;

  beforeEach(async () => {
    locked = await recipeId('peanut-tofu-stir-fry');
    lockedPlan = await aPlan(t, user, profile, {
      startDate: START,
      dayOverrides: [{ date: LOCKED_DAY, lockedSlots: [{ mealType: 'dinner', recipeId: locked }] }],
    });
    const day = lockedPlan.days.find((d) => d.date.slice(0, 10) === LOCKED_DAY)!;
    expect(day.meals.find((m) => m.mealType === 'dinner')!.recipe!.id).toBe(locked);
    // The profile turns out to be allergic to peanuts.
    await t.prisma.profilePreference.upsert({
      where: { profileId: profile.id },
      update: { allergens: ['peanuts'] },
      create: { profileId: profile.id, allergens: ['peanuts'] },
    });
  });

  const lockedDayOf = async () => {
    const fresh = await plans.get(user.id, 'en', lockedPlan.id);
    return fresh.days.find((d) => d.date.slice(0, 10) === LOCKED_DAY)!;
  };

  it('stops a re-roll, naming the day and the meal, and leaves the plan as it was', async () => {
    const outcome = await plans.regenerate(user.id, 'en', lockedPlan.id).then(
      () => null,
      (err: HttpException) => ({ status: err.getStatus(), ...(err.getResponse() as Record<string, unknown>) }),
    );

    expect(outcome).toMatchObject({
      status: 400,
      error: 'LOCKED_RECIPE_INELIGIBLE',
      date: LOCKED_DAY,
      slot: 'dinner',
      recipeId: locked,
    });
    const day = await lockedDayOf();
    expect(day.meals.find((m) => m.mealType === 'dinner')!.recipe!.id).toBe(locked);
    // Until something is done about it, the plan says which meal is the problem.
    expect(day.meals.find((m) => m.mealType === 'dinner')!.restrictionConflicts).toEqual(['allergen']);
  });

  it('is dropped when the re-roll is told to, and does not come back', async () => {
    await plans.regenerate(user.id, 'en', lockedPlan.id, { dropIneligibleLocks: true });

    const day = await lockedDayOf();
    expect(day.meals.find((m) => m.mealType === 'dinner')!.recipe!.id).not.toBe(locked);
    expect(day.overrides?.lockedSlots ?? []).toEqual([]);
    // The next ordinary re-roll has nothing left to trip over.
    await plans.regenerate(user.id, 'en', lockedPlan.id);
    const all = (await plans.get(user.id, 'en', lockedPlan.id)).days.flatMap((d) => d.meals);
    expect(all.some((m) => m.recipe?.allergens.includes('peanuts'))).toBe(false);
  });

  it('is dropped the same way when only its day is re-rolled', async () => {
    const dayId = (await lockedDayOf()).id;

    expect(await refusal(plans.regenerateDay(user.id, 'en', lockedPlan.id, dayId))).toEqual({
      status: 400,
      error: 'LOCKED_RECIPE_INELIGIBLE',
    });
    await plans.regenerateDay(user.id, 'en', lockedPlan.id, dayId, { dropIneligibleLocks: true });

    const day = await lockedDayOf();
    expect(day.meals.find((m) => m.mealType === 'dinner')!.recipe!.id).not.toBe(locked);
    expect(day.overrides?.lockedSlots ?? []).toEqual([]);
    await plans.regenerateDay(user.id, 'en', lockedPlan.id, dayId);
  });

  it('keeps a lock that is still fine through a re-roll that drops the others', async () => {
    const fine = await recipeId('chickpea-tomato-stew');
    const twoLocks = await aPlan(t, user, profile, {
      startDate: '2026-04-06',
      dayOverrides: [
        { date: '2026-04-07', lockedSlots: [{ mealType: 'lunch', recipeId: fine }] },
      ],
    });

    await plans.regenerate(user.id, 'en', twoLocks.id, { dropIneligibleLocks: true });

    const day = (await plans.get(user.id, 'en', twoLocks.id)).days.find((d) => d.date.slice(0, 10) === '2026-04-07')!;
    expect(day.meals.find((m) => m.mealType === 'lunch')!.recipe!.id).toBe(fine);
    expect(day.overrides?.lockedSlots).toEqual([{ mealType: 'lunch', recipeId: fine }]);
  });
});
