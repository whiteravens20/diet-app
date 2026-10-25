// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';

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
      await t.prisma.plannedMeal.update({
        where: { id: meal.id },
        data: {
          recipeId: recipe.id,
          servings: 1,
          quantityScale: 1,
          source: 'CATALOGUE',
          eatenAt: null,
        },
      });
    }
  }
  const read = (plan: MealPlan): Promise<MealPlan> => plans.get(user.id, 'en', plan.id);

  const marks = (plan: MealPlan): (string | null)[][] =>
    plan.days.map((day) => day.meals.map((meal) => meal.cookAhead));
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
    expect(
      marks(await fourDays(false))
        .flat()
        .every((mark) => mark === null),
    ).toBe(true);
  });

  it('is what a plan made for cooking ahead comes to by itself: each meal a dish cooked for two days, and then another', async () => {
    const generation = t.app.get(PlanGenerationService);
    const pinned = generation.nextSeed;
    try {
      // Forty draws, each its own plan: a planner that pairs most meals and not all of them fails some of them.
      for (let seed = 1; seed <= 40; seed += 1) {
        generation.nextSeed = () => seed;
        const plan = await aPlan(t, user, profile, { durationDays: 6, mealPrepFriendly: true });
        const meal = (day: number, slot: string) =>
          plan.days[day]!.meals.find((one) => one.mealType === slot)!;
        for (const first of [0, 2, 4]) {
          for (const cooked of plan.days[first]!.meals) {
            const where = `seed ${seed}, day ${first + 1}, ${cooked.mealType}`;
            const eaten = meal(first + 1, cooked.mealType);
            expect(cooked.cookAhead, where).toBe('cook');
            expect(eaten.recipe?.id, where).toBe(cooked.recipe!.id);
            expect(eaten.cookAhead, where).toBe('cooked');
          }
        }
        // And then another: the third day's meals are not those of the first two.
        for (const cooked of plan.days[0]!.meals)
          expect(
            meal(2, cooked.mealType).recipe?.id,
            `seed ${seed}, day 3, ${cooked.mealType}`,
          ).not.toBe(cooked.recipe!.id);
      }
    } finally {
      generation.nextSeed = pinned;
    }
  });
});
