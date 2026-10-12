// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

/** The fixture recipes the menus below are made of. */
const PORRIDGE = 'milk-porridge';
const EGGS = 'scrambled-eggs-on-toast';
const CHICKEN_RICE = 'chicken-rice-broccoli';
const TOFU_BOWL = 'tofu-rice-bowl';
const SALMON = 'salmon-with-rice';
const STEW = 'chickpea-tomato-stew';

describe('what a plan made for cooking ahead cooks once for two meals', () => {
  let t: TestApp;
  let plans: MealPlansService;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    plans = t.app.get(MealPlansService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  /** Give a day of the plan exactly these recipes, one serving each: breakfast, lunch, dinner. */
  async function menu(plan: MealPlan, day: number, slugs: [string, string, string]): Promise<void> {
    for (const [index, mealType] of (['breakfast', 'lunch', 'dinner'] as const).entries()) {
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: slugs[index]! } });
      const meal = plan.days[day]!.meals.find((planned) => planned.mealType === mealType)!;
      await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { recipeId: recipe.id, servings: 1, quantityScale: 1, source: 'CATALOGUE', eatenAt: null } });
    }
  }
  const read = (plan: MealPlan): Promise<MealPlan> => plans.get(user.id, 'en', plan.id);

  const marks = (plan: MealPlan): (string | null)[][] => plan.days.map((day) => day.meals.map((meal) => meal.cookAhead));
  const fourDays = async (mealPrepFriendly: boolean): Promise<MealPlan> => {
    const plan = await aPlan(t, user, profile, { durationDays: 4, mealPrepFriendly });
    await menu(plan, 0, [PORRIDGE, CHICKEN_RICE, TOFU_BOWL]);
    await menu(plan, 1, [PORRIDGE, CHICKEN_RICE, SALMON]);
    await menu(plan, 2, [PORRIDGE, STEW, SALMON]);
    await menu(plan, 3, [EGGS, STEW, SALMON]);
    return read(plan);
  };

  it('is marked in a plan made for cooking ahead: cooked for the day and the day after, and anew on the third day running', async () => {
    expect(marks(await fourDays(true))).toEqual([
      ['cook', 'cook', null],
      ['cooked', 'cooked', 'cook'],
      // The porridge of the third day is cooked for that day alone: the fourth has eggs.
      [null, 'cook', 'cooked'],
      [null, 'cooked', null],
    ]);
  });

  it('is not marked in a plan that was not made for cooking ahead', async () => {
    expect(marks(await fourDays(false)).flat().every((mark) => mark === null)).toBe(true);
  });

  it('is what a plan made for cooking ahead comes to by itself: a dish on two days running, and another after it', async () => {
    const plan = await aPlan(t, user, profile, { durationDays: 6, mealPrepFriendly: true });

    const all = marks(plan).flat();
    expect(all.filter((mark) => mark === 'cook').length).toBeGreaterThanOrEqual(3);
    // Every lunch of the first day is on the second as well, and not on the third.
    const lunch = (day: number): string => plan.days[day]!.meals.find((meal) => meal.mealType === 'lunch')!.recipe!.id;
    expect(lunch(1)).toBe(lunch(0));
    expect(lunch(2)).not.toBe(lunch(0));
  });
});
