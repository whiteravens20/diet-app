// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, RebalanceResult, ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, as, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

const DATE = '2026-01-06';

describe("a meal of the user's own in the place of a planned one, and a meal taken off its day", () => {
  let t: TestApp;
  let user: TestUser;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    plan = await aPlan(t, user, await aProfile(t, user));
  });

  afterAll(async () => {
    await t.close();
  });

  const dayOf = (of: MealPlan, date = DATE) => of.days.find((day) => day.date === date)!;
  const ownMeal = (replaces?: string, status = 201) =>
    t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${DATE}/custom-meal`)
      .set(as(user))
      .send({
        name: 'Pizza out',
        mealType: 'dinner',
        nutrition: { calories: 900, protein: 35, fat: 35, carbs: 110 },
        ...(replaces ? { replaces } : {}),
      })
      .expect(status);

  it('takes the planned meal off the day when the own one is eaten in its place, and fits the rest of the day around it', async () => {
    const dinner = dayOf(plan).meals.find((meal) => meal.mealType === 'dinner')!;

    const { plan: after } = (await ownMeal(dinner.id)).body as RebalanceResult;

    const day = dayOf(after);
    expect(day.meals.some((meal) => meal.id === dinner.id)).toBe(false);
    expect(
      day.meals.filter((meal) => meal.source === 'USER_CUSTOM').map((meal) => meal.customName),
    ).toEqual(['Pizza out']);
    expect(Math.abs(day.dayNutrition.calories - day.calorieTarget)).toBeLessThanOrEqual(
      day.calorieTarget * 0.1,
    );
  });

  it('puts the own meal beside the others when it takes no place', async () => {
    const { plan: after } = (await ownMeal()).body as RebalanceResult;
    expect(dayOf(after).meals).toHaveLength(dayOf(plan).meals.length + 1);
  });

  it('refuses to take the place of a meal of another day, and changes nothing', async () => {
    const other = dayOf(plan, '2026-01-07').meals[0]!;

    expect((await ownMeal(other.id, 404)).body.error).toBe('MEAL_NOT_FOUND');

    const after = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
      .body as MealPlan;
    expect(after.days.map((day) => day.meals.map((meal) => meal.id))).toEqual(
      plan.days.map((day) => day.meals.map((meal) => meal.id)),
    );
  });

  it('takes a meal off its day, and the meals that are left take its share', async () => {
    const lunch = dayOf(plan).meals.find((meal) => meal.mealType === 'lunch')!;

    const { plan: after, rebalance } = (
      await t
        .http()
        .delete(`/api/meal-plans/${plan.id}/meals/${lunch.id}`)
        .set(as(user))
        .expect(200)
    ).body as RebalanceResult;

    expect(dayOf(after).meals.map((meal) => meal.mealType)).toEqual(['breakfast', 'dinner']);
    expect(rebalance).toMatchObject({ scope: 'day' });
    expect(dayOf(after).dayNutrition.calories).toBeGreaterThan(
      dayOf(plan).dayNutrition.calories - lunch.nutrition.calories,
    );
    expect(after.revision).toBe(plan.revision + 1);
  });

  it("takes the user's own meal off its day as well", async () => {
    const { plan: withOwn } = (await ownMeal()).body as RebalanceResult;
    const own = dayOf(withOwn).meals.find((meal) => meal.source === 'USER_CUSTOM')!;

    const { plan: after } = (
      await t.http().delete(`/api/meal-plans/${plan.id}/meals/${own.id}`).set(as(user)).expect(200)
    ).body as RebalanceResult;

    expect(dayOf(after).meals.some((meal) => meal.source === 'USER_CUSTOM')).toBe(false);
  });

  describe('chosen as an entry of the diary is', () => {
    const chosen = (
      of: Record<string, unknown>,
      status = 201,
      place: Record<string, unknown> = {},
    ) =>
      t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${DATE}/custom-meal`)
        .set(as(user))
        .send({ mealType: 'breakfast', of, ...place })
        .expect(status);
    /** A product of the base with its label, per 100 g. */
    const aProduct = (over: Record<string, unknown> = {}) =>
      t.prisma.product.create({
        data: {
          code: `590${Math.floor(Math.random() * 1e10)}`,
          name: 'Kanapka z jajkiem',
          brand: 'Sklep',
          searchText: 'kanapka z jajkiem sklep',
          unit: 'g',
          calories: 250,
          protein: 11,
          fat: 12,
          carbs: 24,
          origin: 'imported',
          ...over,
        },
      });

    it('takes a product in grams as a meal of its own figures, and fits the rest of the day around it', async () => {
      const product = await aProduct();
      const breakfast = dayOf(plan).meals.find((meal) => meal.mealType === 'breakfast')!;

      const { plan: after } = (
        await chosen({ kind: 'product', productId: product.id, quantity: 120 }, 201, {
          replaces: breakfast.id,
        })
      ).body as RebalanceResult;

      const day = dayOf(after);
      const own = day.meals.find((meal) => meal.source === 'USER_CUSTOM')!;
      expect(own).toMatchObject({ customName: 'Kanapka z jajkiem, Sklep', estimated: false });
      expect(own.nutrition).toMatchObject({ calories: 300, protein: 13, fat: 14, carbs: 29 });
      expect(day.meals.some((meal) => meal.id === breakfast.id)).toBe(false);
      expect(Math.abs(day.dayNutrition.calories - day.calorieTarget)).toBeLessThanOrEqual(
        day.calorieTarget * 0.1,
      );
    });

    it('says a meal of a product whose label lacks a macronutrient is estimated', async () => {
      const product = await aProduct({ protein: null });

      const { plan: after } = (
        await chosen({ kind: 'product', productId: product.id, quantity: 100 })
      ).body as RebalanceResult;

      expect(dayOf(after).meals.find((meal) => meal.source === 'USER_CUSTOM')).toMatchObject({
        estimated: true,
      });
    });

    it('takes an ingredient of the catalogue in an amount, by its name and figures', async () => {
      const banana = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'banana' } });

      const { plan: after } = (
        await chosen({
          kind: 'ingredient',
          ingredientId: banana.id,
          amount: { quantity: 200, unit: 'g' },
        })
      ).body as RebalanceResult;

      const own = dayOf(after).meals.find((meal) => meal.source === 'USER_CUSTOM')!;
      expect(own.customName).toBe('Banana');
      expect(own.nutrition.calories).toBe(Math.round(banana.caloriesPer100 * 2));
    });

    it('takes a recipe as that recipe, sized with the day, and its ingredients go on the shopping list', async () => {
      const recipe = await t.prisma.recipe.findFirstOrThrow({
        where: { slug: 'salmon-with-rice' },
      });
      const breakfast = dayOf(plan).meals.find((meal) => meal.mealType === 'breakfast')!;

      const { plan: after } = (
        await chosen({ kind: 'recipe', recipeId: recipe.id, servings: 1 }, 201, {
          replaces: breakfast.id,
        })
      ).body as RebalanceResult;

      const placed = dayOf(after).meals.find((meal) => meal.recipe?.id === recipe.id)!;
      expect(placed).toMatchObject({ mealType: 'breakfast', source: 'CATALOGUE' });
      const list = (
        await t
          .http()
          .post('/api/shopping-lists/generate')
          .set(as(user))
          .send({ planId: plan.id, fromDate: DATE, toDate: DATE })
          .expect(201)
      ).body as ShoppingList;
      const salmon = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'salmon' } });
      expect(
        list.groups.flatMap((group) => group.items).some((item) => item.ingredientId === salmon.id),
      ).toBe(true);
    });

    it('refuses what the diary refuses: what is not there, a label without energy, a unit a food is not given in', async () => {
      const unknown = '99999999-9999-4999-8999-999999999999';
      expect(
        (await chosen({ kind: 'product', productId: unknown, quantity: 100 }, 404)).body.error,
      ).toBe('PRODUCT_NOT_FOUND');
      const blank = await aProduct({ calories: null });
      expect(
        (await chosen({ kind: 'product', productId: blank.id, quantity: 100 }, 409)).body.error,
      ).toBe('PRODUCT_WITHOUT_FIGURES');
      expect(
        (await chosen({ kind: 'recipe', recipeId: unknown, servings: 1 }, 404)).body.error,
      ).toBe('RECIPE_NOT_FOUND');
      const oil = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'olive-oil' } });
      expect(
        (
          await chosen(
            { kind: 'ingredient', ingredientId: oil.id, amount: { quantity: 2, unit: 'piece' } },
            400,
          )
        ).body.error,
      ).toBe('DIARY_UNIT_NOT_CONVERTIBLE');
      // Nothing of these reached the day.
      expect(
        dayOf(await t.app.get(MealPlansService).get(user.id, 'en', plan.id)).meals.filter(
          (meal) => meal.source === 'USER_CUSTOM',
        ),
      ).toEqual([]);
    });

    it('wants a name and figures of a meal typed by hand', async () => {
      const answer = await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${DATE}/custom-meal`)
        .set(as(user))
        .send({ mealType: 'breakfast' })
        .expect(400);
      expect(answer.body.error).toBe('VALIDATION_FAILED');
    });
  });

  describe('by what is known of it', () => {
    const ownWith = (nutrition: Record<string, number>) =>
      t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${DATE}/custom-meal`)
        .set(as(user))
        .send({ name: 'Out', mealType: 'snack', nutrition });
    const theOwn = (of: MealPlan) => dayOf(of).meals.find((meal) => meal.source === 'USER_CUSTOM')!;

    it('estimates the macronutrients of one known by its calories alone, and says that it did', async () => {
      const { plan: after } = (await ownWith({ calories: 400 }).expect(201))
        .body as RebalanceResult;

      const own = theOwn(after);
      expect(own.estimated).toBe(true);
      expect(own.nutrition.calories).toBe(400);
      const fromMacros =
        own.nutrition.protein * 4 + own.nutrition.fat * 9 + own.nutrition.carbs * 4;
      expect(Math.abs(fromMacros - 400)).toBeLessThanOrEqual(10);
      expect(own.nutrition.protein).toBeGreaterThan(0);
    });

    it('keeps what is typed, and estimates only what is left out', async () => {
      const { plan: after } = (await ownWith({ calories: 400, protein: 30 }).expect(201))
        .body as RebalanceResult;

      const own = theOwn(after);
      expect(own.estimated).toBe(true);
      expect(own.nutrition.protein).toBe(30);
      expect(own.nutrition.fat + own.nutrition.carbs).toBeGreaterThan(0);
    });

    it('estimates nothing where all of it is typed', async () => {
      const { plan: after } = (
        await ownWith({ calories: 400, protein: 30, fat: 10, carbs: 40 }).expect(201)
      ).body as RebalanceResult;

      const own = theOwn(after);
      expect(own.estimated).toBe(false);
      expect(own.nutrition).toEqual({ calories: 400, protein: 30, fat: 10, carbs: 40 });
    });

    it('refuses what it is told holds more than its calories, as the diary does', async () => {
      const refused = await ownWith({ calories: 100, protein: 90 }).expect(400);

      expect(refused.body.error).toBe('DIARY_MACROS_OVER_ENERGY');
    });
  });
});
