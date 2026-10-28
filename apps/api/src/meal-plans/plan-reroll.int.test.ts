// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { AddCustomMealRequest, ProfileInput, type MealPlan, type Profile } from '@diet-app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfilesService } from '../profiles/profiles.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, TEST_TODAY, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { isoDate } from './plan-days.js';

describe('making a plan again, or a part of it', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let plans: MealPlansService;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    plans = t.app.get(MealPlansService);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  afterEach(() => {
    todayIs(TEST_TODAY);
  });

  afterAll(async () => {
    await t.close();
  });

  const todayIs = (date: string) => {
    t.app.get(PlanGenerationService).today = () => date;
  };
  const regenerate = (plan: MealPlan, body?: Record<string, unknown>) =>
    t.http().post(`/api/meal-plans/${plan.id}/regenerate`).set(as(user)).send(body);
  const changeDay = (plan: MealPlan, day: number, body?: Record<string, unknown>) =>
    t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${plan.days[day]!.id}/regenerate`)
      .set(as(user))
      .send(body);
  const mealIds = (plan: MealPlan) =>
    plan.days.map((day) => day.meals.map((meal) => meal.id).sort());
  /** For each day, whether none of its meals is one it had before. */
  const filledAgain = (before: MealPlan, after: MealPlan) =>
    after.days.map(
      (day, i) =>
        day.meals.length > 0 &&
        day.meals.every((meal) => !before.days[i]!.meals.some((old) => old.id === meal.id)),
    );
  /** For each day, whether its meals are the ones it had. */
  const untouched = (before: MealPlan, after: MealPlan) =>
    mealIds(after).map((ids, i) => JSON.stringify(ids) === JSON.stringify(mealIds(before)[i]));

  describe('a plan of five days from the fifth of January, on the seventh', () => {
    let plan: MealPlan;

    beforeEach(async () => {
      plan = await aPlan(t, user, profile, { durationDays: 5 });
      todayIs('2026-01-07');
    });

    it('leaves the days before today as they are, and fills the others again', async () => {
      const again: MealPlan = (await regenerate(plan).expect(201)).body;

      expect(untouched(plan, again).slice(0, 2)).toEqual([true, true]);
      expect(filledAgain(plan, again).slice(2)).toEqual([true, true, true]);
      expect(again.days.map((day) => day.id)).toEqual(plan.days.map((day) => day.id));
      expect(again.revision).toBe(plan.revision + 1);
    });

    it('fills the days before today as well when the request says so', async () => {
      const again: MealPlan = (await regenerate(plan, { includePast: true }).expect(201)).body;

      expect(filledAgain(plan, again)).toEqual([true, true, true, true, true]);
    });

    it('fills the days from one day on, or from one day to another, and no others', async () => {
      const fromTheFourth: MealPlan = (await regenerate(plan, { from: '2026-01-08' }).expect(201))
        .body;
      expect(untouched(plan, fromTheFourth)).toEqual([true, true, true, false, false]);

      const theThird: MealPlan = (
        await regenerate(fromTheFourth, { from: '2026-01-07', to: '2026-01-07' }).expect(201)
      ).body;
      expect(untouched(fromTheFourth, theThird)).toEqual([true, true, false, true, true]);

      const upToTheFourth: MealPlan = (await regenerate(theThird, { to: '2026-01-08' }).expect(201))
        .body;
      // The first two days are before today.
      expect(untouched(theThird, upToTheFourth)).toEqual([true, true, false, false, true]);
    });

    it('refuses days that are not days of the plan, and days in the wrong order', async () => {
      for (const range of [
        { from: '2026-01-04' },
        { to: '2026-01-10' },
        { from: '2026-01-08', to: '2026-01-07' },
      ]) {
        expect((await regenerate(plan, range).expect(400)).body.error).toBe('RANGE_OUTSIDE_PLAN');
      }
      expect((await fresh(plan)).revision).toBe(plan.revision);
    });

    it('refuses when every day asked for is before today, until the request says to fill those too', async () => {
      expect((await regenerate(plan, { to: '2026-01-06' }).expect(409)).body.error).toBe(
        'NOTHING_TO_REGENERATE',
      );
      expect((await changeDay(plan, 0).expect(409)).body.error).toBe('NOTHING_TO_REGENERATE');
      expect((await fresh(plan)).revision).toBe(plan.revision);

      const yesterday: MealPlan = (await changeDay(plan, 1, { includePast: true }).expect(201))
        .body;
      expect(untouched(plan, yesterday)).toEqual([true, false, true, true, true]);
    });

    it('keeps a part that is filled again in the plan as it is, and the whole plan with the profile as it is now', async () => {
      await t.app.get(ProfilesService).update(
        user.id,
        profile.id,
        ProfileInput.parse({
          ...ProfileInput.parse(profile),
          dietType: 'vegan',
          manualCalorieTarget: 1900,
        }),
      );
      const targets = (of: MealPlan) => of.days.map((day) => day.calorieTarget);

      const part: MealPlan = (await regenerate(plan, { from: '2026-01-08' }).expect(201)).body;
      expect(part.dietType).toBe('balanced');
      expect(targets(part)).toEqual(targets(plan));

      const whole: MealPlan = (await regenerate(part).expect(201)).body;
      expect(whole.dietType).toBe('vegan');
      // The days before today keep the targets they had; the others follow the profile.
      expect(targets(whole)).toEqual([...targets(plan).slice(0, 2), 1900, 1900, 1900]);
      for (const day of whole.days.slice(2))
        for (const meal of day.meals) expect(meal.recipe!.dietTags).toContain('vegan');
    });
  });

  const fresh = (plan: MealPlan) => plans.get(user.id, 'en', plan.id);

  describe('a meal that was eaten', () => {
    it('stays, and the rest of its day is filled around it', async () => {
      const plan = await aPlan(t, user, profile, { durationDays: 2 });
      const breakfast = plan.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
      const eaten = (await plans.setEaten(user.id, 'en', plan.id, breakfast.id, true)).plan;

      const again: MealPlan = (await regenerate(eaten).expect(201)).body;

      const day = again.days[0]!;
      expect(day.meals.map((meal) => meal.mealType)).toEqual(['breakfast', 'lunch', 'dinner']);
      expect(day.meals[0]).toMatchObject({
        id: breakfast.id,
        recipe: { id: breakfast.recipe!.id },
      });
      expect(day.meals[0]!.eatenAt).not.toBeNull();
      expect(
        day.meals.slice(1).every((meal) => !eaten.days[0]!.meals.some((old) => old.id === meal.id)),
      ).toBe(true);
      // The other two meals were budgeted from what the breakfast left of the day.
      expect(Math.abs(day.calorieDelta)).toBeLessThanOrEqual(day.calorieTarget * 0.1);
    });

    it('is replaced with the rest when the request says so', async () => {
      const plan = await aPlan(t, user, profile, { durationDays: 1 });
      const breakfast = plan.days[0]!.meals[0]!;
      await plans.setEaten(user.id, 'en', plan.id, breakfast.id, true);

      const again: MealPlan = (await changeDay(plan, 0, { replaceEaten: true }).expect(201)).body;

      expect(again.days[0]!.meals.map((meal) => meal.mealType)).toEqual([
        'breakfast',
        'lunch',
        'dinner',
      ]);
      expect(
        again.days[0]!.meals.some((meal) => meal.id === breakfast.id || meal.eatenAt !== null),
      ).toBe(false);
    });
  });

  /**
   * The plan once its day `index` is skipped, as the settings of a day skip
   * it: it keeps what was eaten of it. The settings of a day that has passed by
   * the server's clock stay as they are, so the plan is to begin today.
   */
  const skip = async (of: MealPlan, index: number): Promise<MealPlan> => {
    const day = of.days[index]!;
    return (
      await t
        .http()
        .put(`/api/meal-plans/${of.id}/days/${day.id}/settings`)
        .set(as(user))
        .send({
          dayType: 'normal',
          skip: true,
          mealCount: day.mealCount,
          calorieTarget: null,
          cookTimeBudgetMinutes: null,
          useUpBy: false,
          revision: of.revision,
        })
        .expect(200)
    ).body as MealPlan;
  };

  describe('a day the user skips', () => {
    it('keeps what was eaten of it, also when the meals eaten on the other days are replaced', async () => {
      const plan = await aPlan(t, user, profile, {
        durationDays: 2,
        startDate: isoDate(new Date()),
      });
      for (const day of plan.days) {
        const breakfast = day.meals.find((meal) => meal.mealType === 'breakfast')!;
        await plans.setEaten(user.id, 'en', plan.id, breakfast.id, true);
      }
      const skipped = await skip(await fresh(plan), 1);
      expect(skipped.days[1]!.meals.map((meal) => meal.eatenAt !== null)).toEqual([true]);

      const again: MealPlan = (await regenerate(skipped, { replaceEaten: true }).expect(201)).body;

      expect(again.days[0]!.meals.some((meal) => meal.eatenAt !== null)).toBe(false);
      expect(again.days[1]).toMatchObject({ skipped: true, meals: skipped.days[1]!.meals });
    });

    it('is nothing to make again on its own', async () => {
      const skipped = await skip(
        await aPlan(t, user, profile, { durationDays: 2, startDate: isoDate(new Date()) }),
        1,
      );

      expect((await changeDay(skipped, 1).expect(409)).body.error).toBe('NOTHING_TO_REGENERATE');
      expect(
        (await regenerate(skipped, { from: skipped.days[1]!.date }).expect(409)).body.error,
      ).toBe('NOTHING_TO_REGENERATE');
      expect((await fresh(skipped)).revision).toBe(skipped.revision);
    });
  });

  describe("a meal of the user's own", () => {
    const soup = AddCustomMealRequest.parse({
      name: 'Soup',
      mealType: 'lunch',
      nutrition: { calories: 600, protein: 20, fat: 20, carbs: 80 },
    });

    it('stays, beside the meals of the catalogue, which are budgeted from what it leaves of the day', async () => {
      const plan = await aPlan(t, user, profile, { durationDays: 1 });
      const withSoup = (await plans.addCustomMeal(user.id, 'en', plan.id, '2026-01-05', soup)).plan;
      const own = withSoup.days[0]!.meals.find((meal) => meal.source === 'USER_CUSTOM')!;

      for (const again of [
        (await regenerate(withSoup).expect(201)).body as MealPlan,
        (await changeDay(withSoup, 0).expect(201)).body as MealPlan,
      ]) {
        const day = again.days[0]!;
        expect(
          day.meals.filter((meal) => meal.source === 'USER_CUSTOM').map((meal) => meal.id),
        ).toEqual([own.id]);
        expect(
          day.meals.filter((meal) => meal.source === 'CATALOGUE').map((meal) => meal.mealType),
        ).toEqual(['breakfast', 'lunch', 'dinner']);
        expect(Math.abs(day.calorieDelta)).toBeLessThanOrEqual(day.calorieTarget * 0.1);
      }
    });

    it('is replaced with the rest when the request says so', async () => {
      const plan = await aPlan(t, user, profile, { durationDays: 1 });
      const withSoup = (await plans.addCustomMeal(user.id, 'en', plan.id, '2026-01-05', soup)).plan;

      const again: MealPlan = (await regenerate(withSoup, { replaceCustom: true }).expect(201))
        .body;

      expect(again.days[0]!.meals.map((meal) => meal.source)).toEqual([
        'CATALOGUE',
        'CATALOGUE',
        'CATALOGUE',
      ]);
    });
  });

  describe('the limits of the plan, when a part of it is filled again', () => {
    // Five days of breakfast and dinner, no recipe twice: each of the catalogue's five breakfasts is on one day.
    const fiveBreakfasts = { durationDays: 5, mealCount: 2, maxRepeatsPerRecipe: 1 };
    const breakfasts = (of: MealPlan) =>
      of.days.map((day) => day.meals.find((meal) => meal.mealType === 'breakfast')!.recipe!.id);

    it('hold over the days that stay: a day filled again gets the one breakfast the others leave it', async () => {
      let plan = await aPlan(t, user, profile, fiveBreakfasts);
      const before = breakfasts(plan);
      expect(new Set(before).size).toBe(5);

      for (const day of [0, 2, 4]) {
        plan = (await changeDay(plan, day).expect(201)).body;
        expect(breakfasts(plan)).toEqual(before);
      }
      plan = (await regenerate(plan, { from: '2026-01-06', to: '2026-01-07' }).expect(201)).body;
      expect(new Set(breakfasts(plan)).size).toBe(5);
      expect(
        new Set(plan.days.flatMap((day) => day.meals.map((meal) => meal.recipe!.id))).size,
      ).toBe(10);
    });

    it('give way for the days filled again only when the request says so, and the plan keeps its own', async () => {
      const plan = await aPlan(t, user, profile, fiveBreakfasts);
      // The breakfast of the third day is marked to avoid: the four that are left are on the other days.
      await t.prisma.favorite.create({
        data: { profileId: profile.id, recipeId: breakfasts(plan)[2]!, sentiment: 'avoid' },
      });
      const outside = [{ date: '2026-01-07', slot: 'breakfast', gaveWay: ['variety_floor'] }];

      const refused = await changeDay(plan, 2).expect(422);
      expect(refused.body.details).toEqual({ needs: ['variety_floor'], meals: outside });
      expect(untouched(plan, await fresh(plan))).toEqual([true, true, true, true, true]);

      const allowed: MealPlan = (
        await changeDay(plan, 2, { allowRelaxations: ['variety_floor'] }).expect(201)
      ).body;
      expect(allowed.report!.relaxations).toEqual(outside);
      // What was let give way for a part of the plan is not what the plan may let give way from here on.
      expect(allowed.options.allowRelaxations).toEqual([]);
      expect(
        (await regenerate(allowed, { from: '2026-01-07' }).expect(422)).body.details.needs,
      ).toEqual(['variety_floor']);
    });
  });
});
