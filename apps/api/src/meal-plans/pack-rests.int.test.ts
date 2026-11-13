// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile, ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aSwap, as, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { keepRestsOfRecipes, restsOf, type StoredRest } from './plan-days.js';

/** The fixture recipes the menus below are made of. */
const CHICKEN_RICE = 'chicken-rice-broccoli'; // 150 g of chicken a serving, from a pack of 500 g
const SKILLET = 'chicken-tomato-skillet'; // 180 g of chicken
const TOFU_BOWL = 'tofu-rice-bowl'; // no chicken
const STEW = 'chickpea-tomato-stew';
const EGGS = 'scrambled-eggs-on-toast';

describe('the rest of a pack a meal finishes', () => {
  let t: TestApp;
  let plans: MealPlansService;
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;
  let chickenId: string;

  beforeAll(async () => {
    t = await createTestApp();
    plans = t.app.get(MealPlansService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    chickenId = (await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'chicken-breast' } }))
      .id;
  });

  afterAll(async () => {
    await t.close();
  });

  /** 30 g of chicken, as the planner keeps a rest: 49.5 kcal of it. */
  const rest = (amount = 30): StoredRest => ({
    ingredientId: chickenId,
    amount,
    unit: 'g',
    figures: { calories: 1.65 * amount, protein: 0.31 * amount, fat: 0.036 * amount, carbs: 0 },
    label: {
      fiber: { grams: 0, atLeast: false },
      sugars: { grams: 0, atLeast: false },
      salt: { grams: 0.0007 * amount, atLeast: false },
      saturatedFat: { grams: 0.01 * amount, atLeast: false },
    },
  });

  /** Give the day exactly these recipes, one serving each: breakfast, lunch, dinner. */
  async function menu(day: number, slugs: [string, string, string]): Promise<void> {
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
  const lunchOf = (read: MealPlan, day = 0) =>
    read.days[day]!.meals.find((meal) => meal.mealType === 'lunch')!;
  const withRests = async (mealId: string, rests: StoredRest[]): Promise<void> => {
    await t.prisma.plannedMeal.update({ where: { id: mealId }, data: { rests } });
  };
  const read = (): Promise<MealPlan> => plans.get(user.id, 'en', plan.id);

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
    plan = await aPlan(t, user, profile, { durationDays: 2 });
    await menu(0, [EGGS, CHICKEN_RICE, STEW]);
    await menu(1, [EGGS, TOFU_BOWL, STEW]);
  });

  it("is in the line of its ingredient and in the meal's figures, and the packs count it", async () => {
    const before = await read();
    await withRests(lunchOf(before).id, [rest()]);
    const after = await read();

    const lineOf = (of: MealPlan) =>
      lunchOf(of).ingredients.find((line) => line.ingredientId === chickenId)!;
    expect(lineOf(before).rest).toBeUndefined();
    expect(lineOf(after).quantity).toBeCloseTo(lineOf(before).quantity + 30, 6);
    expect(lineOf(after).rest).toMatchObject({ quantity: 30 });
    expect(lineOf(after).rest!.display).toMatchObject({ quantity: 30, unit: 'g' });
    // 49.5 kcal more, rounded with the meal's own.
    expect(
      lunchOf(after).nutrition.calories - lunchOf(before).nutrition.calories,
    ).toBeGreaterThanOrEqual(49);
    expect(
      lunchOf(after).nutrition.calories - lunchOf(before).nutrition.calories,
    ).toBeLessThanOrEqual(50);
    expect(
      after.days[0]!.dayNutrition.calories - before.days[0]!.dayNutrition.calories,
    ).toBeGreaterThanOrEqual(49);
    // The pack of chicken: 30 g more of it used, 30 g less left.
    const chicken = (of: MealPlan) => of.packs.open.find((pack) => pack.ingredientId === chickenId);
    expect(after.packs.used - before.packs.used).toBe(30);
    expect(chicken(before)!.left - (chicken(after)?.left ?? 0)).toBe(30);
  });

  it('is on the shopping list with its meal', async () => {
    const amount = async (): Promise<number> => {
      const list = (
        await t
          .http()
          .post('/api/shopping-lists/generate')
          .set(as(user))
          .send({ planId: plan.id })
          .expect(201)
      ).body as ShoppingList;
      await t.prisma.shoppingList.deleteMany({ where: { planId: plan.id } });
      return list.groups
        .flatMap((group) => group.items)
        .find((item) => item.ingredientId === chickenId)!.totalQuantity;
    };
    const without = await amount();
    await withRests(lunchOf(await read()).id, [rest()]);

    expect((await amount()) - without).toBeCloseTo(30, 6);
  });

  it('stays with a meal given a recipe that holds its ingredient, goes with one that does not, and comes back with an undone swap', async () => {
    const lunch = lunchOf(await read());
    await withRests(lunch.id, [rest()]);
    const restsNow = async (): Promise<StoredRest[]> =>
      restsOf((await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: lunch.id } })).rests);

    // Another dish of chicken keeps it; one without chicken loses it.
    const skillet = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: SKILLET } });
    await t.prisma.plannedMeal.update({ where: { id: lunch.id }, data: { recipeId: skillet.id } });
    await keepRestsOfRecipes(t.prisma, [lunch.id]);
    expect(await restsNow()).toEqual([rest()]);
    const tofu = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: TOFU_BOWL } });
    await t.prisma.plannedMeal.update({ where: { id: lunch.id }, data: { recipeId: tofu.id } });
    await keepRestsOfRecipes(t.prisma, [lunch.id]);
    expect(await restsNow()).toEqual([]);

    // A swap as the user makes one, and its undo.
    const chickenAgain = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: CHICKEN_RICE } });
    await t.prisma.plannedMeal.update({
      where: { id: lunch.id },
      data: { recipeId: chickenAgain.id, rests: [rest()] },
    });
    const swapped = await aSwap(t, user, {
      planId: plan.id,
      plannedMealId: lunch.id,
      strategy: 'random',
    });
    const now = await t.prisma.plannedMeal.findUniqueOrThrow({
      where: { id: lunch.id },
      include: { recipe: { include: { ingredients: true } } },
    });
    const holds = now.recipe!.ingredients.some((line) => line.ingredientId === chickenId);
    expect(restsOf(now.rests)).toEqual(holds ? [rest()] : []);
    await t
      .http()
      .post('/api/meal-plans/swap-meal/undo')
      .set(as(user))
      .send({ planId: plan.id, revision: swapped.plan.revision })
      .expect(200);
    expect(await restsNow()).toEqual([rest()]);
  });

  it('is fixed food when the day is sized: the meals make room for it', async () => {
    const dayId = (await read()).days[0]!.id;
    const size = () =>
      t.prisma.$transaction((tx) => plans.rebalanceDayInternal(dayId, tx, '2026-01-01'));
    // The day on its target first, as a plan has it.
    await size();
    const before = await read();
    await withRests(lunchOf(before).id, [rest(30)]);
    await size();
    const after = await read();

    // The day comes to as much as it did: the rest's energy is taken off the portions it can move.
    const target = before.days[0]!.calorieTarget;
    expect(
      Math.abs(after.days[0]!.dayNutrition.calories - before.days[0]!.dayNutrition.calories),
    ).toBeLessThanOrEqual(Math.ceil(0.02 * target));
    const moved = after.days[0]!.meals.reduce((sum, meal) => sum + meal.quantityScale, 0);
    const was = before.days[0]!.meals.reduce((sum, meal) => sum + meal.quantityScale, 0);
    expect(moved).toBeLessThan(was);
    expect(
      lunchOf(after).ingredients.find((line) => line.ingredientId === chickenId)!.rest,
    ).toMatchObject({ quantity: 30 });
  });

  it("is part of the account's file", async () => {
    await withRests(lunchOf(await read()).id, [rest()]);
    const text = (
      await t
        .http()
        .get('/api/users/me/export')
        .set(as(user))
        .buffer(true)
        .parse((res, done) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (piece: string) => (body += piece));
          res.on('end', () => done(null, body));
        })
        .expect(200)
    ).body as string;
    const file = JSON.parse(text) as { plans: { days: { meals: { rests: unknown }[] }[] }[] };
    const meals = file.plans.flatMap((one) => one.days).flatMap((one) => one.meals);
    // The database keeps the keys of JSON in an order of its own: compared as values.
    expect(meals.map((meal) => meal.rests)).toContainEqual([rest()]);
  });

  it('is put into a plan that wastes less only of an ingredient of the meal, within 3 % of a day', async () => {
    let given = 0;
    for (const startDate of ['2026-02-02', '2026-03-02', '2026-04-06']) {
      const made = await aPlan(t, user, profile, { startDate, durationDays: 7, lessWaste: true });
      const rows = await t.prisma.plannedMeal.findMany({
        where: { day: { planId: made.id } },
        include: { day: true, recipe: { include: { ingredients: true } } },
      });
      const byDay = new Map<string, number>();
      for (const row of rows) {
        for (const one of restsOf(row.rests)) {
          expect(
            row.recipe!.ingredients.some((line) => line.ingredientId === one.ingredientId),
          ).toBe(true);
          expect(one.amount).toBeGreaterThan(0);
          given += 1;
          byDay.set(row.dayId, (byDay.get(row.dayId) ?? 0) + one.figures.calories);
        }
      }
      for (const [dayId, added] of byDay) {
        const target = rows.find((row) => row.dayId === dayId)!.day.calorieTarget;
        expect(added).toBeLessThanOrEqual(0.03 * target + 0.5);
      }
    }
    // The catalogue of the tests gives the planner rests to put in: what is checked is there.
    expect(given).toBeGreaterThan(0);
  });
});
