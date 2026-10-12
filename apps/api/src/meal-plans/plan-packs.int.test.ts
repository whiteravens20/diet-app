// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

/** The fixture recipes the menus below are made of, with what one serving takes of what comes in a pack that does not keep. */
const PORRIDGE = 'milk-porridge'; // 250 ml of milk, from a litre
const CHICKEN_RICE = 'chicken-rice-broccoli'; // 150 g of chicken, from a pack of 500 g
const SKILLET = 'chicken-tomato-skillet'; // 180 g of chicken, 70 g of bread from a loaf of 500 g
const SALMON = 'salmon-with-rice'; // 140 g of salmon, from a pack of 250 g
const TOFU_BOWL = 'tofu-rice-bowl'; // nothing that comes in such a pack
const STEW = 'chickpea-tomato-stew'; // nothing either
const EGGS = 'scrambled-eggs-on-toast'; // 70 g of bread; the eggs keep

describe('the packs a plan\'s menu opens that do not keep', () => {
  let t: TestApp;
  let plans: MealPlansService;
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    plans = t.app.get(MealPlansService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Give a day of the plan exactly these recipes, one serving each: breakfast, lunch, dinner. */
  async function menu(day: number, slugs: [string, string, string]): Promise<void> {
    for (const [index, mealType] of (['breakfast', 'lunch', 'dinner'] as const).entries()) {
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: slugs[index]! } });
      const meal = plan.days[day]!.meals.find((planned) => planned.mealType === mealType)!;
      await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { recipeId: recipe.id, servings: 1, quantityScale: 1, source: 'CATALOGUE', eatenAt: null } });
    }
  }
  const read = (locale: 'en' | 'pl' = 'en'): Promise<MealPlan> => plans.get(user.id, locale, plan.id);

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
    // Two days, three meals a day.
    plan = await aPlan(t, user, profile, { durationDays: 2 });
    await menu(0, [PORRIDGE, CHICKEN_RICE, SALMON]);
    await menu(1, [PORRIDGE, CHICKEN_RICE, SKILLET]);
  });

  it('are counted whole against what the menu uses of them, and those it does not finish are named', async () => {
    const { packs } = await read();

    // A litre of milk for 500 ml, a pack of chicken for 480 g, one of salmon for 140 g, a loaf for 70 g.
    expect(packs.bought).toBe(1000 + 500 + 250 + 500);
    expect(packs.used).toBe(500 + 480 + 140 + 70);
    expect(packs.open.map((pack) => [pack.name, pack.unit, pack.packSize, pack.packs, pack.left, pack.wasted])).toEqual([
      ['Wholegrain bread', 'g', 500, 1, 430, true],
      ['Whole milk', 'ml', 1000, 1, 500, true],
      ['Salmon', 'g', 250, 1, 110, true],
      // What is left of the chicken is under the three tenths of a pack that a plan accepts.
      ['Chicken breast', 'g', 500, 1, 20, false],
    ]);
  });

  it('leave out what is bought loose and what keeps: broccoli, rice, oats', async () => {
    const names = (await read()).packs.open.map((pack) => pack.name);

    expect(names).not.toContain('Broccoli');
    expect(names).not.toContain('White rice');
    expect(names).not.toContain('Rolled oats');
  });

  it('follow the menu as it is: a meal made larger takes more of its pack', async () => {
    const dinner = plan.days[0]!.meals.find((meal) => meal.mealType === 'dinner')!;
    await t.prisma.plannedMeal.update({ where: { id: dinner.id }, data: { quantityScale: 1.5 } });

    const salmon = (await read()).packs.open.find((pack) => pack.name === 'Salmon')!;

    // 210 g of 250: the pack is used well enough.
    expect(salmon).toMatchObject({ left: 40, wasted: false });
  });

  it('are named in the language the plan is read in, and are part of what the route answers', async () => {
    expect((await read('pl')).packs.open.map((pack) => pack.name)).toContain('Pierś z kurczaka');

    const answer = await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200);
    expect(answer.body.packs).toMatchObject({ bought: 2250, used: 1190 });
  });

  it('are none for a menu that opens no such pack', async () => {
    await menu(0, [EGGS, TOFU_BOWL, STEW]);
    await menu(1, [EGGS, TOFU_BOWL, STEW]);

    const { packs } = await read();

    // The bread of two breakfasts is all that comes in a pack that does not keep.
    expect(packs).toMatchObject({ bought: 500, used: 140 });
    expect(packs.open.map((pack) => pack.name)).toEqual(['Wholegrain bread']);
  });
});
