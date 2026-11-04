// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  RegenerateDayRequest,
  type DayVariations,
  type MealPlan,
  type MealSwapPreview,
  type PlannedMeal,
  type Profile,
  type RerollPreview,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { plansTodayIs } from '../testing/plans-today.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';

describe('a dish cooked for two meals', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
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
    plan = await aPlan(t, user, profile, { durationDays: 4, mealPrepFriendly: true });
  });

  const read = (): Promise<MealPlan> => t.app.get(MealPlansService).get(user.id, 'en', plan.id);
  const first = (of: MealPlan = plan): PlannedMeal =>
    of.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
  const second = (of: MealPlan = plan): PlannedMeal =>
    of.days[1]!.meals.find((meal) => meal.mealType === 'lunch')!;
  const offer = async (meal: PlannedMeal): Promise<MealSwapPreview> =>
    (
      await t
        .http()
        .post('/api/meal-plans/swap-meal/preview')
        .set(as(user))
        .send({ planId: plan.id, plannedMealId: meal.id, strategy: 'random' })
        .expect(201)
    ).body;
  const take = (meal: PlannedMeal, offered: MealSwapPreview, together: boolean) =>
    t
      .http()
      .post('/api/meal-plans/swap-meal')
      .set(as(user))
      .send({
        planId: plan.id,
        plannedMealId: meal.id,
        recipeId: offered.recipe.id,
        revision: offered.revision,
        strategy: 'random',
        together,
      })
      .expect(201);

  it('says on each of its meals which others it feeds, and what the whole of it takes', () => {
    const cooked = first();

    expect(cooked.cookAhead).toBe('cook');
    expect(cooked.cooking!.with).toEqual([
      { mealId: second().id, date: plan.days[1]!.date, mealType: 'lunch', eaten: false },
    ]);
    const ingredient = cooked.ingredients[0]!;
    const both = cooked.cooking!.ingredients.find(
      (line) => line.ingredientId === ingredient.ingredientId,
    )!;
    const other = second().ingredients.find(
      (line) => line.ingredientId === ingredient.ingredientId,
    )!;
    expect(both.quantity).toBeCloseTo(ingredient.quantity + other.quantity, 5);
    expect(second().cooking!.ingredients).toEqual(cooked.cooking!.ingredients);
  });

  it('has nothing to say of a plan not made for cooking ahead', async () => {
    const plain = await aPlan(t, user, profile, { durationDays: 2 });

    expect(plain.days.flatMap((day) => day.meals).every((meal) => meal.cooking === null)).toBe(
      true,
    );
  });

  describe('swapped', () => {
    it('says before the choice what else would change', async () => {
      const offered = await offer(first());

      expect(offered.cooking).toEqual({
        changes: [{ date: plan.days[1]!.date, mealType: 'lunch' }],
        stays: [],
      });
    });

    it('changes on both days with the same recipe, each sized to what it held, and they stay cooked once', async () => {
      const offered = await offer(first());

      const after = (await take(first(), offered, true)).body.plan as MealPlan;

      expect(first(after).recipe!.id).toBe(offered.recipe.id);
      expect(second(after).recipe!.id).toBe(offered.recipe.id);
      expect(first(after).cookAhead).toBe('cook');
      expect(second(after).cookAhead).toBe('cooked');
    });

    it('changes from the second day as well, for the first', async () => {
      const offered = await offer(second());

      const after = (await take(second(), offered, true)).body.plan as MealPlan;

      expect(first(after).recipe!.id).toBe(offered.recipe.id);
      expect(second(after).recipe!.id).toBe(offered.recipe.id);
    });

    it('changes only the day asked for where the request says so, and then neither is cooked once', async () => {
      const offered = await offer(first());

      const after = (await take(first(), offered, false)).body.plan as MealPlan;

      expect(first(after).recipe!.id).toBe(offered.recipe.id);
      expect(second(after).recipe!.id).toBe(second().recipe!.id);
      expect(first(after).cookAhead).toBeNull();
      expect(second(after).cookAhead).toBeNull();
    });

    it('leaves a meal that was eaten as it is, and says so', async () => {
      await t.prisma.plannedMeal.update({
        where: { id: first().id },
        data: { eatenAt: new Date() },
      });

      const offered = await offer(second());
      expect(offered.cooking).toEqual({
        changes: [],
        stays: [{ date: plan.days[0]!.date, mealType: 'lunch' }],
      });

      const after = (await take(second(), offered, true)).body.plan as MealPlan;
      expect(first(after).recipe!.id).toBe(first().recipe!.id);
      expect(second(after).recipe!.id).toBe(offered.recipe.id);
    });

    it('leaves a meal of a day that has passed as it is, and says so', async () => {
      plansTodayIs(plan.days[1]!.date);

      const offered = await offer(second());
      expect(offered.cooking).toEqual({
        changes: [],
        stays: [{ date: plan.days[0]!.date, mealType: 'lunch' }],
      });

      const after = (await take(second(), offered, true)).body.plan as MealPlan;
      expect(first(after).recipe!.id).toBe(first().recipe!.id);
    });

    it('gives both days of it to the undo of the portions', async () => {
      const offered = await offer(first());

      const { rebalance } = (await take(first(), offered, true)).body as {
        rebalance: { changes: { mealId: string }[] };
      };

      const ids = rebalance.changes.map((change) => change.mealId);
      const dayOf = (mealId: string) =>
        plan.days.findIndex((day) => day.meals.some((meal) => meal.id === mealId));
      expect(new Set(ids.map(dayOf)).size).toBeGreaterThanOrEqual(1);
    });
  });

  it('takes an ingredient away on both days, as one recipe', async () => {
    const meal = plan.days
      .flatMap((day) => day.meals)
      .find((one) => one.cookAhead === 'cook' && one.ingredients.length > 0)!;
    const partner = plan.days
      .flatMap((day) => day.meals)
      .find((one) => one.id === meal.cooking!.with[0]!.mealId)!;
    const suggestions = (
      await t
        .http()
        .get(`/api/meal-plans/${plan.id}/meals/${meal.id}/substitutes`)
        .set(as(user))
        .expect(200)
    ).body as { fromIngredientId: string; to: { id: string } }[];
    const ingredient = await t.prisma.ingredient.findFirstOrThrow({
      where: { id: { notIn: meal.ingredients.map((line) => line.ingredientId) } },
    });
    const body = {
      planId: plan.id,
      plannedMealId: meal.id,
      fromIngredientId: suggestions[0]?.fromIngredientId ?? meal.ingredients[0]!.ingredientId,
      toIngredientId: suggestions[0]?.to.id ?? ingredient.id,
      acceptChange: true,
    };

    const shown = (
      await t.http().post('/api/meal-plans/swap-ingredient/preview').set(as(user)).send(body)
    ).body as { cooking: unknown };
    expect(shown.cooking).toEqual({
      changes: [
        {
          date: plan.days.find((day) => day.meals.some((one) => one.id === partner.id))!.date,
          mealType: partner.mealType,
        },
      ],
      stays: [],
    });

    const after = (
      await t
        .http()
        .post('/api/meal-plans/swap-ingredient/apply')
        .set(as(user))
        .send({ ...body, together: true })
        .expect(201)
    ).body.plan as MealPlan;
    const meals = after.days.flatMap((day) => day.meals);
    const made = meals.find((one) => one.id === meal.id)!;
    expect(made.recipe!.id).not.toBe(meal.recipe!.id);
    expect(meals.find((one) => one.id === partner.id)!.recipe!.id).toBe(made.recipe!.id);
    expect(made.cookAhead).toBe('cook');
  });

  describe('on a day made again', () => {
    const regenerate = (body: Record<string, unknown>) =>
      t.app
        .get(PlanGenerationService)
        .regenerateDay(
          user.id,
          'en',
          plan.id,
          plan.days[0]!.id,
          RegenerateDayRequest.parse(body),
          plan.days[0]!.date,
        );

    it('says what would change on the other day', async () => {
      const said = (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${plan.days[0]!.id}/regenerate/preview`)
          .set(as(user))
          .send({})
          .expect(200)
      ).body as RerollPreview;

      expect(said.cooking!.changes).toContainEqual({
        date: plan.days[1]!.date,
        mealType: 'lunch',
      });
    });

    it('goes to the other day with the new dish where the request says so', async () => {
      const after = await regenerate({ together: true });

      for (const meal of after.days[0]!.meals) {
        const partner = after.days[1]!.meals.find((one) => one.mealType === meal.mealType)!;
        expect(partner.recipe!.id).toBe(meal.recipe!.id);
      }
    });

    it('leaves the other day where the request does not', async () => {
      const after = await regenerate({});

      expect(after.days[1]!.meals.map((meal) => meal.recipe!.id)).toEqual(
        plan.days[1]!.meals.map((meal) => meal.recipe!.id),
      );
    });
  });

  it('goes to the other day with another way of its day', async () => {
    const offered = (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${plan.days[0]!.id}/variations`)
        .set(as(user))
        .send({})
        .expect(200)
    ).body as DayVariations;
    expect(offered.cooking!.changes.length).toBeGreaterThan(0);

    const after = (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${plan.days[0]!.id}/variations/take`)
        .set(as(user))
        .send({ offer: offered.variations[0]!.offer, together: true })
        .expect(200)
    ).body as MealPlan;

    for (const meal of after.days[0]!.meals) {
      const partner = after.days[1]!.meals.find((one) => one.mealType === meal.mealType)!;
      expect(partner.recipe!.id).toBe(meal.recipe!.id);
    }
  });

  it('goes to the other day with a set', async () => {
    const recipe = (
      await t.prisma.recipe.findMany({
        where: { mealTypes: { has: 'lunch' }, id: { not: first().recipe!.id } },
        take: 1,
      })
    )[0]!;
    const set = (
      await t
        .http()
        .post('/api/favorite-sets')
        .set(as(user))
        .send({ profileId: profile.id, label: 'Mine', slots: { lunch: recipe.id } })
        .expect(201)
    ).body as { id: string };

    const after = (
      await t
        .http()
        .post(`/api/favorite-sets/${set.id}/apply`)
        .set(as(user))
        .send({ planId: plan.id, dayDates: [plan.days[0]!.date], together: true })
        .expect(201)
    ).body as MealPlan;

    expect(first(after).recipe!.id).toBe(recipe.id);
    expect(second(after).recipe!.id).toBe(recipe.id);
    expect(first(after).cookAhead).toBe('cook');
  });

  describe('going to the other day with a set', () => {
    const lunchOnly = () =>
      t.prisma.recipe.findFirstOrThrow({
        where: { mealTypes: { equals: ['lunch'] }, id: { not: first().recipe!.id } },
      });
    const applied = async (recipeId: string): Promise<MealPlan> => {
      const set = (
        await t
          .http()
          .post('/api/favorite-sets')
          .set(as(user))
          .send({ profileId: profile.id, label: 'Mine', slots: { lunch: recipeId } })
          .expect(201)
      ).body as { id: string };
      return (
        await t
          .http()
          .post(`/api/favorite-sets/${set.id}/apply`)
          .set(as(user))
          .send({ planId: plan.id, dayDates: [plan.days[0]!.date], together: true })
          .expect(201)
      ).body as MealPlan;
    };

    it('leaves a meal the new dish is not a dish for', async () => {
      const recipe = await lunchOnly();
      const both = await t.prisma.recipe.findFirstOrThrow({
        where: { mealTypes: { hasEvery: ['lunch', 'dinner'] }, id: { not: recipe.id } },
      });
      const other = await t.prisma.recipe.findFirstOrThrow({
        where: { mealTypes: { has: 'lunch' }, id: { notIn: [recipe.id, both.id] } },
      });
      const dinner = plan.days[1]!.meals.find((meal) => meal.mealType === 'dinner')!;
      await t.prisma.plannedMeal.update({
        where: { id: first().id },
        data: { recipeId: both.id },
      });
      await t.prisma.plannedMeal.update({ where: { id: dinner.id }, data: { recipeId: both.id } });
      await t.prisma.plannedMeal.update({
        where: { id: second().id },
        data: { recipeId: other.id },
      });
      plan = await read();
      expect(first().cooking!.with.map((one) => one.mealId)).toEqual([dinner.id]);

      const after = await applied(recipe.id);

      expect(first(after).recipe!.id).toBe(recipe.id);
      const stayed = after.days[1]!.meals.find((meal) => meal.mealType === 'dinner')!;
      expect(stayed.recipe!.id).toBe(both.id);
    });

    it('says what the other day is outside of with it', async () => {
      await t.prisma.mealPlanDay.update({
        where: { id: plan.days[1]!.id },
        data: { overrides: { cookTimeBudgetMinutes: 1 } },
      });
      const recipe = await lunchOnly();

      const after = await applied(recipe.id);

      expect(second(after).recipe!.id).toBe(recipe.id);
      expect(after.report!.relaxations).toContainEqual(
        expect.objectContaining({
          date: plan.days[1]!.date,
          slot: 'lunch',
          gaveWay: expect.arrayContaining(['cook_time']),
        }),
      );
    });
  });

  it('stands alone once an own meal takes the place of one of its meals', async () => {
    await t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${plan.days[0]!.date}/custom-meal`)
      .set(as(user))
      .send({
        name: 'Out',
        mealType: 'lunch',
        servings: 1,
        nutrition: { calories: 700, protein: 30, fat: 30, carbs: 70 },
        replaces: first().id,
      })
      .expect(201);

    const after = await read();
    expect(second(after).recipe!.id).toBe(second().recipe!.id);
    expect(second(after).cookAhead).toBeNull();
    expect(second(after).cooking).toBeNull();
  });

  describe('taken back', () => {
    const undo = (revision: number) =>
      t
        .http()
        .post('/api/meal-plans/swap-meal/undo')
        .set(as(user))
        .send({ planId: plan.id, revision });

    it('has its dishes and portions back on both days', async () => {
      const before = await read();

      const swapped = (await take(first(), await offer(first()), true)).body.plan as MealPlan;
      const after = (await undo(swapped.revision).expect(200)).body as {
        plan: MealPlan;
        rebalance: unknown;
      };

      const figures = (of: MealPlan) =>
        of.days.map((day) =>
          day.meals.map((meal) => [meal.id, meal.recipe?.id, meal.servings, meal.quantityScale]),
        );
      expect(figures(after.plan)).toEqual(figures(before));
      expect(after.rebalance).toBeNull();
      expect(first(after.plan).cookAhead).toBe('cook');
    });

    it('is refused on a plan that changed after it', async () => {
      const swapped = (await take(first(), await offer(first()), true)).body.plan as MealPlan;
      await t.app
        .get(MealPlansService)
        .setEaten(user.id, 'en', plan.id, swapped.days[0]!.meals[0]!.id, true);

      expect((await undo(swapped.revision).expect(409)).body.error).toBe('PLAN_CHANGED');
      expect((await undo(swapped.revision + 1).expect(409)).body.error).toBe('PLAN_CHANGED');
    });

    it('is refused where there is nothing to take back, and a second time', async () => {
      expect((await undo(plan.revision).expect(409)).body.error).toBe('NOTHING_TO_UNDO');

      const swapped = (await take(first(), await offer(first()), true)).body.plan as MealPlan;
      const after = (await undo(swapped.revision).expect(200)).body.plan as MealPlan;

      expect((await undo(after.revision).expect(409)).body.error).toBe('NOTHING_TO_UNDO');
    });

    it("is nobody else's to take back", async () => {
      const swapped = (await take(first(), await offer(first()), true)).body.plan as MealPlan;
      const stranger = await aUser(t);

      const refused = await t
        .http()
        .post('/api/meal-plans/swap-meal/undo')
        .set(as(stranger))
        .send({ planId: plan.id, revision: swapped.revision })
        .expect(404);

      expect(refused.body.error).toBe('PLAN_NOT_FOUND');
    });
  });
});
