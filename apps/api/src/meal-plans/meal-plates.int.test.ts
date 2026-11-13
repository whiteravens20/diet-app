// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  GeneratePlanRequest,
  type MealPlan,
  type PlannedMeal,
  type Profile,
  type ShoppingList,
} from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aSwap, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { PLATE_RANGE } from '../engine/plates.js';
import { plateOfMeal, storedPlateOf } from './plan-days.js';
import { plateDishesOf } from './plates-store.js';

describe('a person’s own plate of a dish both people of a joint plan eat', () => {
  let t: TestApp;
  let user: TestUser;
  let adam: Profile;
  let ewa: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    t.app.get(PlanGenerationService).nextSeed = () => 7;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    adam = await aProfile(t, user, { name: 'Adam', mealCount: 3, dietType: 'high_protein' });
    ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
      mealCount: 3,
    });
  });

  const ask = (first: Profile, second?: Profile) =>
    GeneratePlanRequest.parse({
      profileId: first.id,
      ...(second ? { withProfileId: second.id } : {}),
      startDate: '2026-01-05',
      durationDays: 7,
    });
  const together = (first: Profile, second: Profile): Promise<MealPlan> =>
    t.app.get(PlanGenerationService).generate(user.id, 'en', ask(first, second));
  const read = (planId: string): Promise<MealPlan> =>
    t.app.get(MealPlansService).get(user.id, 'en', planId);
  const mealsOf = (plan: MealPlan) => plan.days.flatMap((day) => day.meals);
  /** The meals whose plate is not the recipe's: a line of them holds a share of its own. */
  const plated = (plan: MealPlan): PlannedMeal[] =>
    mealsOf(plan).filter((meal) => meal.ingredients.some((line) => line.share !== undefined));

  it('is given at a shared dish served on a plate, its energy kept, and the pot is the sum of the two plates', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const ours = [...plated(adams), ...plated(ewas)];

    expect(plated(adams).length).toBeGreaterThan(0);
    const dishes = await plateDishesOf(
      t.prisma,
      ours.map((meal) => meal.recipe!.id),
    );
    for (const meal of ours) {
      expect(meal.shared).not.toBeNull();
      expect(dishes.has(meal.recipe!.id)).toBe(true);
      for (const line of meal.ingredients) {
        if (line.share === undefined) continue;
        expect(line.share).toBeGreaterThanOrEqual(0.5);
        expect(line.share).toBeLessThanOrEqual(1.5);
      }
      // The vegetables of a plate never fewer than the recipe's.
      const { plate: stored } = await t.prisma.plannedMeal.findUniqueOrThrow({
        where: { id: meal.id },
        select: { plate: true },
      });
      expect(plateOfMeal(stored)!.vegetables).toBeGreaterThanOrEqual(1);
      // The plate moves energy between the parts of the dish, and keeps the portion's.
      const factor = meal.servings * meal.quantityScale;
      const portion = meal.recipe!.nutritionPerServing.calories * factor;
      expect(Math.abs(meal.nutrition.calories - portion)).toBeLessThanOrEqual(
        Math.max(2, portion * 0.01),
      );
      // What it holds of each macronutrient is the recipe's portion with what the plate changes of it.
      const { plate } = await t.prisma.plannedMeal.findUniqueOrThrow({
        where: { id: meal.id },
        select: { plate: true },
      });
      const change = plateOfMeal(plate)!.perServing;
      for (const key of ['protein', 'fat', 'carbs'] as const)
        expect(meal.nutrition[key]).toBe(
          Math.round((meal.recipe!.nutritionPerServing[key] + change[key]) * factor),
        );
      // The pot takes what both plates take, line by line.
      meal.shared!.pot.forEach((line, index) => {
        expect(line.quantity).toBeCloseTo(
          meal.ingredients[index]!.quantity + meal.shared!.with.ingredients[index]!.quantity,
          6,
        );
      });
    }
    // The other person's portion is their plate, as their plan holds it.
    const [meal] = plated(adams);
    const theirs = mealsOf(ewas).find((one) => one.id === meal!.shared!.with.mealId)!;
    expect(meal!.shared!.with.ingredients).toEqual(theirs.ingredients);
  });

  it('is only at a dish both eat served on a plate, never in a plan of one person', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const dishes = await plateDishesOf(
      t.prisma,
      mealsOf(adams).flatMap((meal) => (meal.recipe ? [meal.recipe.id] : [])),
    );
    for (const meal of mealsOf(adams)) {
      if (meal.shared === null || !dishes.has(meal.recipe?.id ?? ''))
        expect(meal.ingredients.every((line) => line.share === undefined)).toBe(true);
    }

    const alone = await t.app.get(PlanGenerationService).generate(user.id, 'en', ask(adam));
    expect(plated(alone)).toEqual([]);
    expect(
      await t.prisma.plannedMeal.count({
        where: { day: { planId: alone.id }, plate: { not: Prisma.DbNull } },
      }),
    ).toBe(0);
  });

  it('counts in its day, the diary and the shopping list as the plate holds it', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [meal] = plated(adams);
    const day = adams.days.find((one) => one.meals.some((m) => m.id === meal!.id))!;
    // A day is what its meals hold, each on its plate, with their toppings.
    const sum = (key: 'calories' | 'protein' | 'fat' | 'carbs') =>
      day.meals.reduce(
        (total, one) => total + one.nutrition[key] + (one.topping?.nutrition[key] ?? 0),
        0,
      );
    expect(day.dayNutrition.protein).toBe(sum('protein'));
    expect(day.dayNutrition.carbs).toBe(sum('carbs'));

    // The diary of the day holds the meal as its plate does, once it is eaten.
    const plans = t.app.get(MealPlansService);
    const today = plans.today;
    plans.today = () => day.date;
    await t
      .http()
      .patch(`/api/meal-plans/${adams.id}/meals/${meal!.id}/eaten`)
      .set(as(user))
      .send({ eaten: true, forAll: false })
      .expect(200);
    plans.today = today;
    const eaten = mealsOf(await read(adams.id)).find((one) => one.id === meal!.id)!;
    const diary = await t
      .http()
      .get(`/api/diary/day?profileId=${adam.id}&date=${day.date}`)
      .set(as(user))
      .expect(200);
    const inDiary = (
      diary.body.plan.meals as { id: string; nutrition: { protein: number } }[]
    ).find((one) => one.id === eaten.id)!;
    expect(inDiary.nutrition.protein).toBe(
      eaten.nutrition.protein + (eaten.topping?.nutrition.protein ?? 0),
    );
    // An eaten meal keeps the plate it was eaten on.
    expect(eaten.ingredients).toEqual(meal!.ingredients);

    // The list buys what the plates take: without them, less of a part a plate holds more of, and more of one it holds less of.
    const bought = async () => {
      const list = (
        await t
          .http()
          .post('/api/shopping-lists/generate')
          .set(as(user))
          .send({ planId: adams.id })
          .expect(201)
      ).body as ShoppingList;
      return new Map(
        list.groups.flatMap((group) => group.items).map((item) => [item.ingredientId, item]),
      );
    };
    const onPlates = await bought();
    const moved = new Map<string, number>();
    for (const one of plated(adams))
      for (const line of one.ingredients)
        if (line.share !== undefined)
          moved.set(
            line.ingredientId,
            (moved.get(line.ingredientId) ?? 0) + line.quantity * (1 - 1 / line.share),
          );
    await t.prisma.plannedMeal.updateMany({
      where: { day: { planId: adams.id } },
      data: { plate: Prisma.DbNull },
    });
    const plain = await bought();
    const [ingredientId, more] = [...moved].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]!;
    const difference =
      onPlates.get(ingredientId)!.totalQuantity - (plain.get(ingredientId)?.totalQuantity ?? 0);
    expect(Math.sign(difference)).toBe(Math.sign(more));
  });

  it('goes from both plates when one person gives the dish another recipe', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [meal] = plated(adams);

    // Ewa takes another recipe for her own meal: the dish is no longer one both eat, and neither plate stays.
    await aSwap(t, user, {
      planId: ewas.id,
      plannedMealId: meal!.shared!.with.mealId,
      strategy: 'random',
    });
    const his = mealsOf(await read(adams.id)).find((one) => one.id === meal!.id)!;
    expect(his.recipe!.id).toBe(meal!.recipe!.id);
    expect(his.shared).toBeNull();
    expect(his.ingredients.every((line) => line.share === undefined)).toBe(true);
    const hers = mealsOf(await read(ewas.id)).find((one) => one.id === meal!.shared!.with.mealId)!;
    expect(hers.ingredients.every((line) => line.share === undefined)).toBe(true);
    expect(
      await t.prisma.plannedMeal.count({
        where: { id: { in: [his.id, hers.id] }, plate: { not: Prisma.DbNull } },
      }),
    ).toBe(0);
  });

  it('is chosen again for the new dish when both give the dish they share another recipe', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [meal] = plated(adams);
    const ask = { planId: adams.id, plannedMealId: meal!.id, strategy: 'random', forAll: true };
    const offered = (
      await t.http().post('/api/meal-plans/swap-meal/preview').set(as(user)).send(ask).expect(201)
    ).body as { recipe: { id: string }; revision: number };
    await t
      .http()
      .post('/api/meal-plans/swap-meal')
      .set(as(user))
      .send({ ...ask, recipeId: offered.recipe.id, revision: offered.revision })
      .expect(201);

    // Each plate is of the new dish: none where it is not served on a plate, and what a plate changes is its parts'.
    const dish = (await plateDishesOf(t.prisma, [offered.recipe.id])).get(offered.recipe.id);
    for (const id of [meal!.id, meal!.shared!.with.mealId]) {
      const row = await t.prisma.plannedMeal.findUniqueOrThrow({
        where: { id },
        select: { recipeId: true, plate: true },
      });
      expect(row.recipeId).toBe(offered.recipe.id);
      const plate = plateOfMeal(row.plate);
      if (!dish) expect(plate).toBeNull();
      else if (plate) expect(plate).toEqual(storedPlateOf(dish, plate));
    }
  });

  it('keeps the plate a dish has where another would bring its day hardly nearer', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [meal] = plated(adams);
    const day = adams.days.find((one) => one.meals.some((m) => m.id === meal!.id))!;
    const dish = (await plateDishesOf(t.prisma, [meal!.recipe!.id])).get(meal!.recipe!.id)!;
    const stored = async () =>
      plateOfMeal(
        (
          await t.prisma.plannedMeal.findUniqueOrThrow({
            where: { id: meal!.id },
            select: { plate: true },
          })
        ).plate,
      );
    const chosen = (await stored())!;
    // A plate a hundredth of a part away from the one chosen, its energy kept by the part with the most of it.
    const [most, other] = (['protein', 'starch', 'vegetables'] as const)
      .filter((part) => dish.parts[part].calories >= 1)
      .sort((a, b) => dish.parts[b].calories - dish.parts[a].calories);
    const by = chosen[other!] - 0.01 >= PLATE_RANGE[other!].least ? -0.01 : 0.01;
    const near = {
      protein: chosen.protein,
      starch: chosen.starch,
      vegetables: chosen.vegetables,
      [other!]: chosen[other!] + by,
      [most!]: chosen[most!] - (by * dish.parts[other!].calories) / dish.parts[most!].calories,
    };
    await t.prisma.plannedMeal.update({
      where: { id: meal!.id },
      data: { plate: storedPlateOf(dish, near) as unknown as Prisma.InputJsonValue },
    });

    // The day is sized again: the plate it has stays, for no other brings the day nearer by enough.
    await t.prisma.$transaction((tx) =>
      t.app.get(MealPlansService).rebalanceDayInternal(day.id, tx, '2026-01-01'),
    );
    expect(await stored()).toEqual(storedPlateOf(dish, near));
  });
});
