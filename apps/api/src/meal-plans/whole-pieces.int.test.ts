// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  GeneratePlanRequest,
  type DiaryDay,
  type MealPlan,
  type MealSwapPreview,
  type PlannedMeal,
  type Profile,
  type ShoppingList,
  type SwapPreview,
} from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';

/** Three large eggs of 55 g a serving, on toast. */
const EGGS = 'scrambled-eggs-on-toast';
const PORRIDGE = 'milk-porridge';
const CHICKEN_RICE = 'chicken-rice-broccoli';
const SALMON = 'salmon-with-rice';
const TOFU_SCRAMBLE = 'tofu-scramble';
const EGG_GRAMS = 55;

describe('eggs in planned meals', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let plans: MealPlansService;
  let eggId: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    t.app.get(PlanGenerationService).nextSeed = () => 7;
    plans = t.app.get(MealPlansService);
    eggId = (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'large-egg' } })).id;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  const read = (plan: { id: string }): Promise<MealPlan> => plans.get(user.id, 'en', plan.id);
  const meal = (plan: MealPlan, day: number, mealType: string): PlannedMeal =>
    plan.days[day]!.meals.find((one) => one.mealType === mealType)!;
  /** What a meal's lines take of eggs, in eggs. */
  const eggsOf = (lines: PlannedMeal['ingredients']): number =>
    lines
      .filter((line) => line.ingredientId === eggId)
      .reduce((sum, line) => sum + line.quantity, 0) / EGG_GRAMS;

  /** Give a meal a recipe at so many servings, cooked as the recipe is. */
  async function serve(of: PlannedMeal, slug: string, servings: number): Promise<void> {
    const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug } });
    await t.prisma.plannedMeal.update({
      where: { id: of.id },
      data: {
        recipeId: recipe.id,
        servings,
        quantityScale: 1,
        source: 'CATALOGUE',
        eatenAt: null,
        plate: Prisma.DbNull,
      },
    });
  }
  /** Every meal of a plan on a recipe without eggs, but those given eggs after. */
  async function noEggs(plan: MealPlan): Promise<void> {
    for (const day of plan.days)
      for (const one of day.meals)
        await serve(
          one,
          one.mealType === 'breakfast'
            ? PORRIDGE
            : one.mealType === 'lunch'
              ? CHICKEN_RICE
              : SALMON,
          1,
        );
  }

  it('are taken whole by a meal cooked on its own: its lines, its figures, the list and the diary', async () => {
    const made = await aPlan(t, user, profile, { durationDays: 2 });
    await noEggs(made);
    // A serving and three quarters: five eggs and a quarter, cooked as five.
    await serve(meal(made, 0, 'breakfast'), EGGS, 1.75);

    const plan = await read(made);
    const breakfast = meal(plan, 0, 'breakfast');
    expect(eggsOf(breakfast.ingredients)).toBeCloseTo(5);
    expect(
      breakfast.ingredients.find((line) => line.ingredientId === eggId)!.display,
    ).toMatchObject({ quantity: 5, unit: 'piece' });

    // The same meal as it was planned: what a quarter of an egg holds more.
    await t.prisma.plannedMeal.update({
      where: { id: breakfast.id },
      data: { wholePieces: false },
    });
    const exact = meal(await read(made), 0, 'breakfast');
    expect(eggsOf(exact.ingredients)).toBeCloseTo(5.25);
    // A quarter of an egg, 13.75 g: 19.7 kcal, 1.8 g protein, 1.3 g fat (the test catalogue's egg: 143, 13, 9.5 in 100 g).
    expect(breakfast.nutrition.calories - exact.nutrition.calories).toBeCloseTo(-19.7, -0.5);
    expect(breakfast.nutrition.protein - exact.nutrition.protein).toBeCloseTo(-1.8, -0.5);
    expect(breakfast.nutrition.fat - exact.nutrition.fat).toBeCloseTo(-1.3, -0.5);
    await t.prisma.plannedMeal.update({ where: { id: breakfast.id }, data: { wholePieces: true } });

    // The list buys five eggs, where it would buy six of what the meal takes exactly.
    const list = (
      await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(user))
        .send({ planId: plan.id })
        .expect(201)
    ).body as ShoppingList;
    const eggs = list.groups
      .flatMap((group) => group.items)
      .find((item) => item.ingredientId === eggId)!;
    expect(eggs.totalQuantity).toBeCloseTo(5);

    // The diary counts the meal eaten as the plan does.
    await t.prisma.plannedMeal.update({
      where: { id: breakfast.id },
      data: { eatenAt: new Date() },
    });
    const diary = (
      await t
        .http()
        .get(`/api/diary/day?profileId=${profile.id}&date=${plan.days[0]!.date}`)
        .set(as(user))
        .expect(200)
    ).body as DiaryDay;
    expect(diary.plan!.meals.find((one) => one.id === breakfast.id)!.nutrition).toEqual(
      breakfast.nutrition,
    );
  });

  it('are counted whole in the list of plans, as the plan counts them', async () => {
    const made = await aPlan(t, user, profile, { durationDays: 2 });
    await noEggs(made);
    await serve(meal(made, 0, 'breakfast'), EGGS, 1.75);
    const listed = async (): Promise<number> =>
      (
        (await t.http().get(`/api/meal-plans?profileId=${profile.id}`).set(as(user)).expect(200))
          .body as { items: { id: string; averageDailyNutrition: { calories: number } }[] }
      ).items.find((item) => item.id === made.id)!.averageDailyNutrition.calories;
    const averageOf = (plan: MealPlan): number =>
      Math.round(
        plan.days.reduce(
          (sum, day) => sum + day.meals.reduce((all, one) => all + one.nutrition.calories, 0),
          0,
        ) / plan.days.length,
      );

    const whole = await listed();
    expect(whole).toBe(averageOf(await read(made)));
    // The same plan with the meal as it was planned: a quarter of an egg more in one of two days.
    await t.prisma.plannedMeal.update({
      where: { id: meal(made, 0, 'breakfast').id },
      data: { wholePieces: false },
    });
    expect((await listed()) - whole).toBeCloseTo(19.7 / 2, -0.5);
  });

  it('keep what a meal eaten before they were taken whole was planned with', async () => {
    const made = await aPlan(t, user, profile, { durationDays: 2 });
    await noEggs(made);
    await serve(meal(made, 0, 'breakfast'), EGGS, 1.5);
    const breakfast = meal(made, 0, 'breakfast');
    // As the update marks a meal eaten before it.
    await t.prisma.plannedMeal.update({
      where: { id: breakfast.id },
      data: { eatenAt: new Date('2026-01-05T08:00:00Z'), wholePieces: false },
    });

    expect(eggsOf(meal(await read(made), 0, 'breakfast').ingredients)).toBeCloseTo(4.5);
  });

  it('are taken whole by what is cooked once for more meals, each meal its share of that', async () => {
    const made = await aPlan(t, user, profile, { durationDays: 2, mealPrepFriendly: true });
    await noEggs(made);
    await serve(meal(made, 0, 'breakfast'), EGGS, 1.25);
    await serve(meal(made, 1, 'breakfast'), EGGS, 1.5);

    const plan = await read(made);
    const first = meal(plan, 0, 'breakfast');
    const second = meal(plan, 1, 'breakfast');
    expect(first.cookAhead).toBe('cook');
    // 3.75 and 4.5 eggs are 8.25, cooked as eight, each meal its share; cooked apart they would be four and five.
    expect(eggsOf(first.cooking!.ingredients)).toBeCloseTo(8);
    expect(eggsOf(first.ingredients)).toBeCloseTo((3.75 * 8) / 8.25);
    expect(eggsOf(second.ingredients)).toBeCloseTo((4.5 * 8) / 8.25);
    // The list buys what the cooking takes, not the nine of two pots.
    const list = (
      await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(user))
        .send({ planId: plan.id })
        .expect(201)
    ).body as ShoppingList;
    expect(
      list.groups.flatMap((group) => group.items).find((item) => item.ingredientId === eggId)!
        .totalQuantity,
    ).toBeCloseTo(8);
  });

  describe('in a leftover and the meal it was left of', () => {
    /** Half of a serving and a half of eggs eaten at `origin`, 2.25 eggs, and the other half left to `leftover`. */
    async function leftOver(
      origin: PlannedMeal,
      date: string,
      leftover: PlannedMeal,
    ): Promise<void> {
      await serve(origin, EGGS, 1.5);
      await serve(leftover, EGGS, 1.5);
      await t.prisma.plannedMeal.update({
        where: { id: leftover.id },
        data: {
          quantityScale: 0.5,
          leftoverFromDate: new Date(date),
          leftoverFromMealType: origin.mealType,
        },
      });
      await t.prisma.plannedMeal.update({
        where: { id: origin.id },
        data: { quantityScale: 0.5, givenLeftoverId: leftover.id, eatenAt: new Date() },
      });
    }

    it('are taken whole by the two as one pot', async () => {
      const made = await aPlan(t, user, profile, { durationDays: 2 });
      await noEggs(made);
      await leftOver(meal(made, 0, 'lunch'), made.days[0]!.date, meal(made, 1, 'lunch'));

      const plan = await read(made);
      // 2.25 and 2.25 eggs are 4.5, cooked as five: each takes 2.5 of them, where on its own it would take two.
      expect(eggsOf(meal(plan, 0, 'lunch').ingredients)).toBeCloseTo(2.5);
      expect(eggsOf(meal(plan, 1, 'lunch').ingredients)).toBeCloseTo(2.5);
    });

    it('are taken whole as one pot where the leftover went to a plan made later', async () => {
      const first = await aPlan(t, user, profile, { durationDays: 2 });
      const later = await aPlan(t, user, profile, { durationDays: 2, startDate: '2026-01-06' });
      await noEggs(first);
      await noEggs(later);
      await leftOver(meal(first, 0, 'lunch'), first.days[0]!.date, meal(later, 0, 'lunch'));

      expect(eggsOf(meal(await read(first), 0, 'lunch').ingredients)).toBeCloseTo(2.5);
      expect(eggsOf(meal(await read(later), 0, 'lunch').ingredients)).toBeCloseTo(2.5);
    });
  });

  /** A joint plan of two days, and a dish both eat, his and hers, given eggs: his 3.75, her 1.5. */
  async function sharedEggs(): Promise<{ mine: MealPlan; at: number; shared: PlannedMeal }> {
    const ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
    });
    const hers = await t.app.get(PlanGenerationService).generate(
      user.id,
      'en',
      GeneratePlanRequest.parse({
        profileId: ewa.id,
        withProfileId: profile.id,
        startDate: '2026-01-05',
        durationDays: 2,
      }),
    );
    const mine = await read({ id: hers.joint!.planId });
    const at = mine.days.findIndex((day) => day.meals.some((one) => one.shared !== null));
    expect(at).toBeGreaterThanOrEqual(0);
    const shared = mine.days[at]!.meals.find((one) => one.shared !== null)!;
    const theirs = hers.days
      .flatMap((day) => day.meals)
      .find((one) => one.id === shared.shared!.with.mealId)!;
    await serve(shared, EGGS, 1.25);
    await serve(theirs, EGGS, 0.5);
    return { mine, at, shared };
  }

  it("are taken whole by a dish two people eat from one pot, each plate its share of the pot's", async () => {
    const { mine, at, shared } = await sharedEggs();

    const now = meal(await read(mine), at, shared.mealType);
    // 3.75 and 1.5 eggs are 5.25, cooked as 5.
    expect(eggsOf(now.shared!.pot)).toBeCloseTo(5);
    expect(eggsOf(now.ingredients)).toBeCloseTo((3.75 * 5) / 5.25);
    expect(eggsOf(now.shared!.with.ingredients)).toBeCloseTo((1.5 * 5) / 5.25);
  });

  it('are taken whole by each portion of a dish two people cook apart', async () => {
    const { mine, at, shared } = await sharedEggs();
    await t.prisma.sharedMeal.update({ where: { id: shared.shared!.id }, data: { apart: true } });

    const now = meal(await read(mine), at, shared.mealType);
    // His 3.75 cooked as 4, her 1.5 as 2.
    expect(eggsOf(now.ingredients)).toBeCloseTo(4);
    expect(eggsOf(now.shared!.with.ingredients)).toBeCloseTo(2);
    expect(eggsOf(now.shared!.pot)).toBeCloseTo(6);
  });

  describe('in what a change of a meal is shown to come to', () => {
    const ingredientId = async (slug: string): Promise<string> =>
      (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;
    const swapIngredient = async (
      plan: MealPlan,
      of: PlannedMeal,
      from: string,
      to: string,
    ): Promise<{ preview: SwapPreview; applied: PlannedMeal }> => {
      const ask = {
        planId: plan.id,
        plannedMealId: of.id,
        fromIngredientId: await ingredientId(from),
        toIngredientId: await ingredientId(to),
      };
      const preview = (
        await t
          .http()
          .post('/api/meal-plans/swap-ingredient/preview')
          .set(as(user))
          .send(ask)
          .expect(201)
      ).body as SwapPreview;
      await t
        .http()
        .post('/api/meal-plans/swap-ingredient/apply')
        .set(as(user))
        .send({ ...ask, acceptChange: true })
        .expect(201);
      const applied = (await read(plan)).days
        .flatMap((day) => day.meals)
        .find((one) => one.id === of.id)!;
      return { preview, applied };
    };

    it('take eggs whole in a dish offered in the place of a meal', async () => {
      const made = await aPlan(t, user, profile, { durationDays: 1 });
      await noEggs(made);
      const eggs = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: EGGS } });
      const porridge = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: PORRIDGE } });
      // A breakfast holding what a serving and three quarters of the eggs hold: five eggs and a quarter.
      await t.prisma.plannedMeal.update({
        where: { id: meal(made, 0, 'breakfast').id },
        data: { servings: (eggs.caloriesPerServing * 1.75) / porridge.caloriesPerServing },
      });

      const preview = (
        await t
          .http()
          .post('/api/meal-plans/swap-meal/preview')
          .set(as(user))
          .send({
            planId: made.id,
            plannedMealId: meal(made, 0, 'breakfast').id,
            strategy: 'favorite',
            favoriteRecipeId: eggs.id,
          })
          .expect(201)
      ).body as MealSwapPreview;

      expect(preview.servings).toBe(1.75);
      // Five eggs, a quarter of one (13.75 g, 19.7 kcal) less than the servings take exactly.
      expect(preview.after.calories).toBe(
        Math.round(preview.recipe.nutritionPerServing.calories * 1.75 - (13.75 / 100) * 143),
      );
    });

    it('take eggs whole in a substitution for them, as the meal holds them before it', async () => {
      const made = await aPlan(t, user, profile, { durationDays: 1 });
      await noEggs(made);
      await serve(meal(made, 0, 'breakfast'), EGGS, 1.75);
      const before = meal(await read(made), 0, 'breakfast');

      const { preview, applied } = await swapIngredient(made, before, 'large-egg', 'firm-tofu');

      // The five eggs the meal shows leave it, not five and a quarter, from what it holds with them.
      expect(preview.from.display).toMatchObject({ quantity: 5, unit: 'piece' });
      expect(preview.before).toEqual(before.nutrition);
      expect(eggsOf(applied.ingredients)).toBe(0);
    });

    it('take eggs whole in a substitution that brings them, as the meal will hold them', async () => {
      const made = await aPlan(t, user, profile, { durationDays: 1 });
      await noEggs(made);
      await serve(meal(made, 0, 'breakfast'), TOFU_SCRAMBLE, 1);
      const before = meal(await read(made), 0, 'breakfast');

      const { preview, applied } = await swapIngredient(made, before, 'firm-tofu', 'large-egg');

      // What the recipe the meal gets takes of eggs, in the meal's one serving: rounded to whole ones.
      const variant = applied.recipe!;
      const exact =
        variant.ingredients.find((line) => line.ingredientId === eggId)!.quantity /
        variant.servings /
        EGG_GRAMS;
      expect(exact % 1).toBeGreaterThan(0.05);
      const whole = Math.max(1, Math.round(exact));
      expect(preview.to.quantity / EGG_GRAMS).toBeCloseTo(whole);
      expect(preview.to.display).toMatchObject({ quantity: whole, unit: 'piece' });
      expect(preview.after.calories).toBeCloseTo(
        variant.nutritionPerServing.calories + ((whole - exact) * EGG_GRAMS * 143) / 100,
        -0.5,
      );
    });
  });
});
