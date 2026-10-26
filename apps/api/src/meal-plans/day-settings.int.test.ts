// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { DaySettings, DaySettingsPreview, MealPlan, MealPlanDay } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, as, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY_MS = 86_400_000;
/** The day `offset` days from today: the API takes a client's date only near its own. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
/** The day whose settings are changed: tomorrow, in a plan that began the day before yesterday. */
const DATE = day(1);

describe('the settings of a day of a running plan', () => {
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
    plan = await aPlan(t, user, await aProfile(t, user), { startDate: day(-2) });
  });

  afterAll(async () => {
    await t.close();
  });

  const dayOf = (of: MealPlan, date = DATE): MealPlanDay =>
    of.days.find((day) => day.date === date)!;
  /** The settings a day has, as a window opens on them. */
  const settingsOf = (day: MealPlanDay): DaySettings => ({
    dayType: day.overrides?.dayType ?? 'normal',
    skip: day.overrides?.skip ?? false,
    mealCount: day.mealCount,
    calorieTarget: day.overrides?.calorieTarget ?? null,
    cookTimeBudgetMinutes: day.overrides?.cookTimeBudgetMinutes ?? null,
    useUpBy: day.overrides?.useUpBy ?? false,
  });
  const preview = async (of: MealPlan, change: Partial<DaySettings>) =>
    (
      await t
        .http()
        .post(`/api/meal-plans/${of.id}/days/${dayOf(of).id}/settings/preview`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .send({ ...settingsOf(dayOf(of)), ...change })
        .expect(200)
    ).body as DaySettingsPreview;
  const apply = async (
    of: MealPlan,
    change: Partial<DaySettings> & { allowRelaxations?: string[] },
  ) =>
    (
      await t
        .http()
        .put(`/api/meal-plans/${of.id}/days/${dayOf(of).id}/settings`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .send({ ...settingsOf(dayOf(of)), ...change, revision: of.revision })
        .expect(200)
    ).body as MealPlan;
  /** The recipe of each meal of the catalogue on a day, by its meal. */
  const dishes = (day: MealPlanDay) =>
    Object.fromEntries(
      day.meals.filter((meal) => meal.recipe).map((meal) => [meal.mealType, meal.recipe!.id]),
    );
  const insideItsWindow = (day: MealPlanDay) =>
    Math.abs(day.dayNutrition.calories - day.calorieTarget) <= day.calorieTarget * 0.1;

  it('says that the settings the day has change nothing, and changes nothing for them', async () => {
    const said = await preview(plan, {});
    expect(said).toMatchObject({
      unchanged: true,
      added: [],
      calorieTarget: { now: dayOf(plan).calorieTarget, then: dayOf(plan).calorieTarget },
    });
    expect(said.meals.every((meal) => meal.fate === 'stays')).toBe(true);

    const after = await apply(plan, {});
    expect(after.revision).toBe(plan.revision);
  });

  describe('another kind of day', () => {
    it('keeps the dishes in larger portions on a training day, at the target its kind gives', async () => {
      const day = dayOf(plan);
      // A training day aims fifteen in a hundred over the plan's base, to ten kilocalories.
      const { calorieTarget: base } = await t.prisma.mealPlan.findUniqueOrThrow({
        where: { id: plan.id },
      });
      const target = Math.round((base * 1.15) / 10) * 10;

      const said = await preview(plan, { dayType: 'training' });
      expect(said.calorieTarget).toEqual({ now: day.calorieTarget, then: target });
      expect(said.meals.map((meal) => [meal.fate, meal.because])).toEqual(
        day.meals.map(() => ['resized', null]),
      );
      expect(said).toMatchObject({ added: [], fits: true, unchanged: false });
      expect(said.targetMacros.then.carbs).toBeGreaterThan(said.targetMacros.now.carbs);

      const after = dayOf(await apply(plan, { dayType: 'training' }));
      expect(after.calorieTarget).toBe(target);
      expect(after.overrides).toEqual({ dayType: 'training' });
      expect(dishes(after)).toEqual(dishes(day));
      // What the preview said the day would hold is what it holds, to the rounding of its meals.
      expect(Math.abs(after.dayNutrition.calories - said.dayCalories!)).toBeLessThanOrEqual(2);
      expect(insideItsWindow(after)).toBe(true);
    });

    it("takes a target of the day's own in place of its kind, and says when it goes under the floor", async () => {
      // A man's floor is 1500.
      const said = await preview(plan, { dayType: 'training', calorieTarget: 1400 });
      expect(said).toMatchObject({ calorieTarget: { then: 1400 }, belowSafetyFloor: true });

      const after = dayOf(await apply(plan, { calorieTarget: 2100 }));
      expect(after).toMatchObject({ calorieTarget: 2100, overrides: { calorieTarget: 2100 } });
      expect(insideItsWindow(after)).toBe(true);
    });
  });

  describe('another number of meals', () => {
    it('keeps the dishes of the meals that stay, in other portions, and draws a recipe for the meal the day gains', async () => {
      const day = dayOf(plan);
      expect(day.mealCount).toBe(3);

      const said = await preview(plan, { mealCount: 4 });
      expect(said.added).toEqual(['snack']);
      expect(said.meals.map((meal) => meal.fate)).toEqual(['resized', 'resized', 'resized']);
      expect(said).toMatchObject({ dayCalories: null, fits: null });

      const after = dayOf(await apply(plan, { mealCount: 4 }));
      expect(after.meals.map((meal) => meal.mealType)).toEqual([
        'breakfast',
        'lunch',
        'snack',
        'dinner',
      ]);
      expect(dishes(after)).toMatchObject(dishes(day));
      expect(after).toMatchObject({ mealCount: 4, overrides: { mealCount: 4 } });
      expect(insideItsWindow(after)).toBe(true);
    });

    it('takes away the meal the day loses, and the others take its share', async () => {
      const day = dayOf(plan);

      const said = await preview(plan, { mealCount: 2 });
      expect(said.meals.map((meal) => [meal.mealType, meal.fate, meal.because])).toEqual([
        ['breakfast', 'resized', null],
        ['lunch', 'removed', 'fewer_meals'],
        ['dinner', 'resized', null],
      ]);
      expect(said.added).toEqual([]);
      expect(said.dayCalories).not.toBeNull();

      const after = dayOf(await apply(plan, { mealCount: 2 }));
      const { lunch, ...staying } = dishes(day);
      expect(lunch).toBeDefined();
      expect(dishes(after)).toEqual(staying);
      // Two dishes may not reach the whole target at the largest serving: the preview says how near they come.
      expect(Math.abs(after.dayNutrition.calories - said.dayCalories!)).toBeLessThanOrEqual(2);
      expect(insideItsWindow(after)).toBe(said.fits);
    });
  });

  describe('a skipped day', () => {
    it('keeps what was eaten of it and nothing else, and is no shortfall', async () => {
      const breakfast = dayOf(plan).meals.find((meal) => meal.mealType === 'breakfast')!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${breakfast.id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);
      const eaten = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
        .body as MealPlan;

      const said = await preview(eaten, { skip: true });
      expect(said.meals.map((meal) => [meal.mealType, meal.fate, meal.because])).toEqual([
        ['breakfast', 'stays', 'eaten'],
        ['lunch', 'removed', 'skipped'],
        ['dinner', 'removed', 'skipped'],
      ]);
      expect(said.fits).toBeNull();

      const after = await apply(eaten, { skip: true });
      expect(dayOf(after)).toMatchObject({ skipped: true, calorieDelta: 0, offTarget: null });
      expect(dayOf(after).meals.map((meal) => meal.id)).toEqual([breakfast.id]);
      // The day is left out of what a day of the plan holds on average.
      const others = after.days.filter((day) => day.date !== DATE);
      const average =
        others.reduce((sum, day) => sum + day.dayNutrition.calories, 0) / others.length;
      expect(Math.abs(after.averageDailyNutrition.calories - average)).toBeLessThanOrEqual(1);
    });

    it('gets the meals of its number again once it is no longer skipped', async () => {
      const skipped = await aPlan(t, user, await aProfile(t, user), {
        startDate: day(-2),
        dayOverrides: [{ date: DATE, skip: true }],
      });
      expect(dayOf(skipped).meals).toEqual([]);

      const said = await preview(skipped, { skip: false });
      expect(said.added).toEqual(['breakfast', 'lunch', 'dinner']);

      const after = dayOf(await apply(skipped, { skip: false }));
      expect(after.meals.map((meal) => meal.mealType)).toEqual(['breakfast', 'lunch', 'dinner']);
      expect(after).toMatchObject({ skipped: false, overrides: null });
      expect(insideItsWindow(after)).toBe(true);
    });
  });

  describe('a limit that rules a dish out', () => {
    it('draws another recipe for each meal over a new limit on cooking time, and leaves the others as they are', async () => {
      const day = dayOf(plan);
      const minutes = day.meals.map((meal) => meal.recipe!.prepMinutes + meal.recipe!.cookMinutes);
      // Under the longest of the day's dishes: that one, at least, is over it.
      const limit = Math.max(...minutes) - 1;
      const over = day.meals.filter((_, index) => minutes[index]! > limit).map((meal) => meal.id);

      const said = await preview(plan, { cookTimeBudgetMinutes: limit });
      for (const meal of said.meals) {
        expect([meal.fate, meal.because], meal.mealType).toEqual(
          over.includes(meal.mealId) ? ['redrawn', 'over_cook_time'] : ['stays', null],
        );
      }

      // The catalogue may have no other recipe inside the limit: it may then give way, and says so.
      const after = dayOf(
        await apply(plan, { cookTimeBudgetMinutes: limit, allowRelaxations: ['cook_time'] }),
      );
      const ids = new Set(after.meals.map((meal) => meal.id));
      expect(over.every((id) => !ids.has(id))).toBe(true);
      expect(
        day.meals.filter((meal) => !over.includes(meal.id)).every((meal) => ids.has(meal.id)),
      ).toBe(true);
      expect(after.overrides).toEqual({ cookTimeBudgetMinutes: limit });
    });

    it('draws again every meal not yet eaten to use up what the pantry has, and keeps what was eaten', async () => {
      const lunch = dayOf(plan).meals.find((meal) => meal.mealType === 'lunch')!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${lunch.id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);
      const eaten = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
        .body as MealPlan;

      const said = await preview(eaten, { useUpBy: true });
      expect(said.meals.map((meal) => [meal.mealType, meal.fate, meal.because])).toEqual([
        ['breakfast', 'redrawn', 'use_up'],
        ['lunch', 'stays', 'eaten'],
        ['dinner', 'redrawn', 'use_up'],
      ]);
    });
  });

  it('says that a shopping list of the plan goes out of date, where one covers the day', async () => {
    expect((await preview(plan, { dayType: 'rest' })).listOutOfDate).toBe(false);
    await t
      .http()
      .post('/api/shopping-lists/generate')
      .set(as(user))
      .send({ planId: plan.id })
      .expect(201);
    const withList = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
      .body as MealPlan;

    expect((await preview(withList, { dayType: 'rest' })).listOutOfDate).toBe(true);
    // A change that leaves the meals as they are does nothing to a list.
    expect((await preview(withList, { cookTimeBudgetMinutes: 600 })).listOutOfDate).toBe(false);
  });

  it('refuses a day before today, and a change asked of a plan that changed since', async () => {
    const yesterday = dayOf(plan, day(-1));
    for (const asked of [
      () =>
        t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${yesterday.id}/settings/preview`)
          .send(settingsOf(yesterday)),
      () =>
        t
          .http()
          .put(`/api/meal-plans/${plan.id}/days/${yesterday.id}/settings`)
          .send({ ...settingsOf(yesterday), dayType: 'rest', revision: plan.revision }),
    ]) {
      const past = await asked().set(as(user)).set('X-Client-Date', day(0)).expect(409);
      expect(past.body.error).toBe('DAY_IN_THE_PAST');
    }

    const stale = await t
      .http()
      .put(`/api/meal-plans/${plan.id}/days/${dayOf(plan).id}/settings`)
      .set(as(user))
      .set('X-Client-Date', day(0))
      .send({ ...settingsOf(dayOf(plan)), dayType: 'rest', revision: plan.revision + 1 })
      .expect(409);
    expect(stale.body.error).toBe('PLAN_CHANGED');
    const after = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
      .body as MealPlan;
    expect([dayOf(after), dayOf(after, day(-1))]).toMatchObject([
      { calorieTarget: dayOf(plan).calorieTarget, overrides: null },
      { calorieTarget: yesterday.calorieTarget, overrides: null },
    ]);
  });
});
