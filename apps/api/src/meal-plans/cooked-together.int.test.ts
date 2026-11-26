// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  AddCustomMealRequest,
  GeneratePlanRequest,
  PutLeftoverRequest,
  RebalanceRequest,
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
import { plansTodayIs, restartPlansToday } from '../testing/plans-today.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ShoppingListsService } from '../shopping-lists/shopping-lists.service.js';
import { LeftoversService } from './leftovers.service.js';
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

describe('a pot cooked already', () => {
  let t: TestApp;
  let user: TestUser;
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
    plan = await aPlan(t, user, await aProfile(t, user), {
      durationDays: 4,
      mealPrepFriendly: true,
    });
  });

  const plans = () => t.app.get(MealPlansService);
  const read = (): Promise<MealPlan> => plans().get(user.id, 'en', plan.id);
  /** Lunch of a day: on the first day it is cooked for the second as well. */
  const lunchOf = (of: MealPlan, day: number): PlannedMeal =>
    of.days[day]!.meals.find((meal) => meal.mealType === 'lunch')!;
  const portion = (meal: PlannedMeal) => meal.servings * meal.quantityScale;
  /** The first day's lunch eaten: the pot is cooked. */
  const cooked = () =>
    plans().setEaten(user.id, 'en', plan.id, lunchOf(plan, 0).id, true, plan.days[0]!.date);
  /** Every meal of the first day eaten: each of its pots is cooked, for the second day as well. */
  const allCooked = async () => {
    for (const meal of plan.days[0]!.meals)
      await plans().setEaten(user.id, 'en', plan.id, meal.id, true, plan.days[0]!.date);
  };
  /** A meal of the user's own on the second day: the rest of its day is sized down for it. */
  const snackTomorrow = () =>
    plans().addCustomMeal(
      user.id,
      'en',
      plan.id,
      plan.days[1]!.date,
      AddCustomMealRequest.parse({ name: 'Bar', mealType: 'snack', nutrition: { calories: 450 } }),
    );

  it('keeps what it was cooked in once its first meal is eaten, and offers what a smaller portion leaves in it', async () => {
    const list = await t.app.get(ShoppingListsService).generate(user.id, 'en', {
      planId: plan.id,
      fromDate: plan.days[0]!.date,
      toDate: plan.days[3]!.date,
    });
    const cookedFor = portion(lunchOf(plan, 1));
    await allCooked();
    const amounts = lunchOf(await read(), 0).cooking!.ingredients.map((line) => line.quantity);

    await snackTomorrow();

    const after = await read();
    const tomorrow = lunchOf(after, 1);
    expect(portion(tomorrow)).toBeLessThan(cookedFor);
    expect(tomorrow.pot).toEqual({
      cookedOn: plan.days[0]!.date,
      cooked: cookedFor,
      rest: expect.closeTo(cookedFor - portion(tomorrow), 6),
      held: false,
      offer: 'ok',
    });
    // The pot says what it was cooked in, and the list what was bought for it: every meal of the second day is of a
    // pot cooked already.
    expect(lunchOf(after, 0).cooking!.ingredients.map((line) => line.quantity)).toEqual(amounts);
    expect((await t.app.get(ShoppingListsService).get(user.id, 'en', list.id)).stale).toBe(false);

    // What the pot leaves goes to the day after as a leftover, and the meal keeps its portion.
    const leftovers = t.app.get(LeftoversService);
    const offered = await leftovers.offer(user.id, 'en', plan.id, tomorrow.id, null, true);
    expect(offered.date).toBe(plan.days[2]!.date);
    expect(offered.portion.servings).toBeCloseTo(tomorrow.pot!.rest, 6);
    expect(offered.other).toBeNull();
    await leftovers.put(
      user.id,
      'en',
      plan.id,
      tomorrow.id,
      PutLeftoverRequest.parse({ mealType: 'lunch', left: 1, fromPot: true }),
    );
    const carried = await read();
    const dayAfter = lunchOf(carried, 2);
    expect(dayAfter.leftover).toMatchObject({ date: plan.days[1]!.date, mealType: 'lunch' });
    expect(portion(dayAfter)).toBeCloseTo(tomorrow.pot!.rest, 6);
    expect(lunchOf(carried, 1)).toMatchObject({
      eatenAt: null,
      quantityScale: tomorrow.quantityScale,
      carriedTo: { date: plan.days[2]!.date, mealType: 'lunch' },
      pot: { rest: 0, held: false, offer: null },
    });

    // Taken back, the day after has its dish again, and the pot its rest.
    await leftovers.undo(user.id, 'en', plan.id, dayAfter.id, false);
    const undone = await read();
    expect(lunchOf(undone, 2).leftover).toBeNull();
    expect(lunchOf(undone, 1)).toMatchObject({ carriedTo: null, pot: { offer: 'ok' } });
  });

  it('leaves the meal it was the rest of as it is when the leftover is taken back, eaten since', async () => {
    await allCooked();
    await snackTomorrow();
    const tomorrow = lunchOf(await read(), 1);
    const leftovers = t.app.get(LeftoversService);
    await leftovers.put(
      user.id,
      'en',
      plan.id,
      tomorrow.id,
      PutLeftoverRequest.parse({ mealType: 'lunch', left: 1, fromPot: true }),
    );
    await plans().setEaten(user.id, 'en', plan.id, tomorrow.id, true, plan.days[1]!.date);

    await leftovers.undo(user.id, 'en', plan.id, lunchOf(await read(), 2).id, false);

    expect(lunchOf(await read(), 1)).toMatchObject({
      eatenAt: expect.any(String),
      quantityScale: tomorrow.quantityScale,
      carriedTo: null,
    });
  });

  it('is cooked once the day of its first meal has passed, eaten or not', async () => {
    plansTodayIs(plan.days[1]!.date);
    try {
      const tomorrow = lunchOf(await read(), 1);
      expect(tomorrow.pot).toEqual({
        cookedOn: plan.days[0]!.date,
        cooked: portion(tomorrow),
        rest: 0,
        held: false,
        offer: null,
      });
    } finally {
      restartPlansToday();
    }
  });

  it('forgets what it was cooked for once its first meal is no longer eaten, its day still to come', async () => {
    await cooked();
    await snackTomorrow();
    const tomorrow = lunchOf(await read(), 1);
    expect(tomorrow.pot).not.toBeNull();

    await plans().setEaten(user.id, 'en', plan.id, lunchOf(plan, 0).id, false, plan.days[0]!.date);

    expect(lunchOf(await read(), 1).pot).toBeNull();
    expect(
      (await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: tomorrow.id } })).cookedServings,
    ).toBeNull();
  });

  it('holds a portion the day would grow at what the pot holds, and the other meals take the rest of the day', async () => {
    const cookedFor = portion(lunchOf(plan, 1));
    await cooked();
    // The second day's dinner goes: what it held is left to the day's other meals.
    const dinner = plan.days[1]!.meals.find((meal) => meal.mealType === 'dinner')!;
    await t
      .http()
      .delete(`/api/meal-plans/${plan.id}/meals/${dinner.id}`)
      .set(as(user))
      .expect(200);

    const tomorrow = lunchOf(await read(), 1);
    expect(portion(tomorrow)).toBeLessThanOrEqual(cookedFor + 1e-6);
    expect(tomorrow.pot).toMatchObject({ cooked: cookedFor, rest: 0, held: true, offer: null });
    const breakfast = (await read()).days[1]!.meals.find((meal) => meal.mealType === 'breakfast')!;
    const before = plan.days[1]!.meals.find((meal) => meal.mealType === 'breakfast')!;
    expect(portion(breakfast)).toBeGreaterThan(portion(before));

    // Sized again as it stands, the day is left as it is: the pot still holds the meal.
    await plans().rebalance(
      user.id,
      'en',
      plan.id,
      RebalanceRequest.parse({ scope: 'day', date: plan.days[1]!.date }),
    );
    expect(lunchOf(await read(), 1).pot).toMatchObject({ rest: 0, held: true });
  });

  it('says it holds a portion only where a sizing would have given the meal more', async () => {
    const sizeTomorrow = (scope: 'day' | 'plan') =>
      plans().rebalance(
        user.id,
        'en',
        plan.id,
        RebalanceRequest.parse({ scope, date: plan.days[1]!.date }),
      );
    // The second day sized as it stands before the pot is cooked: a sizing has nothing to move on it then.
    await sizeTomorrow('day');
    await cooked();
    // Nothing has sized it since the pot was cooked: the meal takes what the pot holds, which does not hold it.
    expect(lunchOf(await read(), 1).pot).toMatchObject({ rest: 0, held: false });

    // Sized again, the day alone and the rest of the plan: neither would give the meal more.
    await sizeTomorrow('day');
    const lunch = lunchOf(await read(), 1);
    expect(lunch.pot).toMatchObject({ rest: 0, held: false });
    expect(
      (await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: lunch.id } })).cookedServings,
    ).not.toBeNull();
    await sizeTomorrow('plan');
    expect(lunchOf(await read(), 1).pot).toMatchObject({ rest: 0, held: false });
  });

  it('holds a portion at what is left in the pot once its rest is carried, and says so only while nothing is left', async () => {
    await allCooked();
    await snackTomorrow();
    const tomorrow = lunchOf(await read(), 1);
    const leftovers = t.app.get(LeftoversService);
    await leftovers.put(
      user.id,
      'en',
      plan.id,
      tomorrow.id,
      PutLeftoverRequest.parse({ mealType: 'lunch', left: 1, fromPot: true }),
    );
    const carried = portion(lunchOf(await read(), 2));
    // The bar goes: the day would give lunch more than the pot has left once its rest went to the day after.
    const bar = (await read()).days[1]!.meals.find((meal) => meal.source === 'USER_CUSTOM')!;
    await t.http().delete(`/api/meal-plans/${plan.id}/meals/${bar.id}`).set(as(user)).expect(200);

    const held = lunchOf(await read(), 1);
    expect(portion(held)).toBeCloseTo(tomorrow.pot!.cooked - carried, 6);
    expect(held.pot).toMatchObject({ rest: 0, held: true, offer: null });

    // Taken back, the rest is in the pot again, for the meal or to be left.
    await leftovers.undo(user.id, 'en', plan.id, lunchOf(await read(), 2).id, false);
    const undone = lunchOf(await read(), 1);
    expect(undone.carriedTo).toBeNull();
    expect(portion(undone) + undone.pot!.rest).toBeCloseTo(tomorrow.pot!.cooked, 6);
  });

  it('holds a portion at its pot where the rest of the plan is sized as well', async () => {
    const cookedFor = portion(lunchOf(plan, 1));
    await cooked();
    // The second day's dinner gone with nothing sized: the day stands below its window.
    const dinner = plan.days[1]!.meals.find((meal) => meal.mealType === 'dinner')!;
    await t.prisma.plannedMeal.delete({ where: { id: dinner.id } });

    await plans().rebalance(
      user.id,
      'en',
      plan.id,
      RebalanceRequest.parse({ scope: 'plan', date: plan.days[1]!.date }),
    );

    const lunch = lunchOf(await read(), 1);
    expect(portion(lunch)).toBeCloseTo(cookedFor, 6);
    expect(lunch.pot).toMatchObject({ rest: 0, held: true });
  });

  it('forgets that it held a portion once the pot is no longer cooked', async () => {
    await cooked();
    const dinner = plan.days[1]!.meals.find((meal) => meal.mealType === 'dinner')!;
    await t
      .http()
      .delete(`/api/meal-plans/${plan.id}/meals/${dinner.id}`)
      .set(as(user))
      .expect(200);
    expect(lunchOf(await read(), 1).pot).toMatchObject({ held: true });

    // Not eaten after all, and eaten again: nothing has sized the day since the pot was cooked again.
    await plans().setEaten(user.id, 'en', plan.id, lunchOf(plan, 0).id, false, plan.days[0]!.date);
    await cooked();

    expect(lunchOf(await read(), 1).pot).toMatchObject({ rest: 0, held: false });
  });

  it('says a pot holds nothing of a portion that leaves some in it, whatever an earlier sizing held', async () => {
    await allCooked();
    await snackTomorrow();
    const tomorrow = lunchOf(await read(), 1);
    expect(tomorrow.pot!.rest).toBeGreaterThan(0);
    await t.prisma.plannedMeal.update({ where: { id: tomorrow.id }, data: { potHeld: true } });

    expect(lunchOf(await read(), 1).pot).toMatchObject({ held: false, offer: 'ok' });
  });

  it('holds a portion at its pot in a plan made together as well', async () => {
    const ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
    });
    let adams = await t.app.get(PlanGenerationService).generate(
      user.id,
      'en',
      GeneratePlanRequest.parse({
        profileId: plan.profileId,
        withProfileId: ewa.id,
        startDate: plan.days[0]!.date,
        durationDays: 4,
        mealPrepFriendly: true,
      }),
    );
    const cookedFor = portion(lunchOf(adams, 1));
    await plans().setEaten(
      user.id,
      'en',
      adams.id,
      lunchOf(adams, 0).id,
      true,
      adams.days[0]!.date,
    );
    // Adam's second dinner goes: what it held is left to the day's other meals.
    const dinner = adams.days[1]!.meals.find((meal) => meal.mealType === 'dinner')!;
    await t
      .http()
      .delete(`/api/meal-plans/${adams.id}/meals/${dinner.id}`)
      .set(as(user))
      .expect(200);

    adams = await plans().get(user.id, 'en', adams.id);
    expect(portion(lunchOf(adams, 1))).toBeCloseTo(cookedFor, 6);
    expect(lunchOf(adams, 1).pot).toMatchObject({ cooked: cookedFor, rest: 0, held: true });
  });

  it('gives the pantry nothing back of a meal eaten from it when its plan goes', async () => {
    // An ingredient of the dish cooked for both lunches that no other meal of the two days takes.
    const lunch = lunchOf(plan, 0);
    const others = plan.days
      .slice(0, 2)
      .flatMap((day) => day.meals.filter((meal) => meal.mealType !== 'lunch'))
      .flatMap((meal) => meal.ingredients.map((line) => line.ingredientId));
    const only = lunch.ingredients.find((line) => !others.includes(line.ingredientId))!;
    expect(only).toBeDefined();
    const lists = t.app.get(ShoppingListsService);
    const list = await lists.generate(user.id, 'en', {
      planId: plan.id,
      fromDate: plan.days[0]!.date,
      toDate: plan.days[1]!.date,
    });
    const row = list.groups
      .flatMap((group) => group.items)
      .find((item) => item.ingredientId === only.ingredientId)!;
    await lists.updateItem(user.id, 'en', list.id, row.id, {
      purchasedQuantity: row.totalQuantity,
    });
    await cooked();

    // Both lunches are of the pot: one eaten, the other cooked already.
    await plans().remove(user.id, 'en', plan.id, plan.days[0]!.date);

    const pantry = await t.prisma.inventoryItem.findMany({
      where: { ingredientId: only.ingredientId },
    });
    expect(pantry).toEqual([]);
  });
});
