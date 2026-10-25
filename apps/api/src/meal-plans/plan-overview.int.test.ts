// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, PlanOverview, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { PlanOverviewService } from './plan-overview.service.js';

describe("what a profile's plan of the moment comes to", () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

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
  });

  /**
   * The overview as somebody sees it for whom it is `today`. The service is asked itself: a request may name a day
   * only near the server's own, and the plans of these tests lie in January.
   */
  const overviewOn = async (today: string): Promise<PlanOverview | null> =>
    (await t.app.get(PlanOverviewService).overview(user.id, 'en', profile.id, today)).overview;
  const planFrom = (startDate: string, durationDays = 3): Promise<MealPlan> =>
    aPlan(t, user, profile, { startDate, durationDays });

  it('is nothing for a profile that has no plan', async () => {
    expect(await overviewOn('2026-01-06')).toBeNull();
  });

  describe('is of one plan', () => {
    let first: MealPlan;
    let second: MealPlan;
    let third: MealPlan;

    beforeEach(async () => {
      first = await planFrom('2026-01-05');
      second = await planFrom('2026-01-12');
      third = await planFrom('2026-01-19');
    });

    it('the one that is under way', async () => {
      expect((await overviewOn('2026-01-13'))!.plan).toEqual({
        id: second.id,
        startDate: '2026-01-12',
        durationDays: 3,
        dietType: 'balanced',
        status: 'active',
      });
      // Its first and its last day are days of it.
      expect((await overviewOn('2026-01-12'))!.plan.id).toBe(second.id);
      expect((await overviewOn('2026-01-14'))!.plan.id).toBe(second.id);
    });

    it('the one that begins next, while none is under way', async () => {
      expect((await overviewOn('2026-01-09'))!.plan).toMatchObject({
        id: second.id,
        status: 'upcoming',
      });
      expect((await overviewOn('2026-01-01'))!.plan).toMatchObject({
        id: first.id,
        status: 'upcoming',
      });
    });

    it('the one that ended last, once none is ahead', async () => {
      expect((await overviewOn('2026-02-01'))!.plan).toMatchObject({
        id: third.id,
        status: 'past',
      });
    });

    it('the newest of two that are under way on the same day', async () => {
      const over = await planFrom('2026-01-13', 2);

      expect((await overviewOn('2026-01-13'))!.plan.id).toBe(over.id);
    });
  });

  it('says what the plan holds against what it aims at, on average and day by day', async () => {
    const plan = await planFrom('2026-01-05');

    const overview = (await overviewOn('2026-01-05'))!;

    expect(overview.energy.planned).toBe(plan.averageDailyNutrition.calories);
    expect(overview.energy.target).toBe(
      Math.round(plan.days.reduce((sum, day) => sum + day.calorieTarget, 0) / 3),
    );
    expect(overview.macros).toEqual({
      planned: {
        protein: plan.averageDailyNutrition.protein,
        fat: plan.averageDailyNutrition.fat,
        carbs: plan.averageDailyNutrition.carbs,
      },
      target: plan.targetMacros,
    });
    expect(overview.days).toEqual(
      plan.days.map((day) => ({
        date: day.date,
        calories: day.dayNutrition.calories,
        target: day.calorieTarget,
        skipped: false,
      })),
    );
    expect(overview.ingredientReuse).toBe(plan.ingredientReuseScore);
    // Every meal of a plan the engine made fits its diet.
    expect(overview.onDiet).toEqual({ meals: 9, of: 9 });
  });

  it('counts what was eaten of the meals of the days that have come', async () => {
    const plan = await planFrom('2026-01-05');
    const [monday, tuesday] = plan.days;
    for (const meal of [monday!.meals[0]!, monday!.meals[1]!, tuesday!.meals[0]!]) {
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${meal.id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);
    }

    // On Monday the day's three meals were due; on Tuesday, six; after the plan, all nine.
    expect((await overviewOn('2026-01-05'))!.eaten).toEqual({ meals: 2, of: 3 });
    expect((await overviewOn('2026-01-06'))!.eaten).toEqual({ meals: 3, of: 6 });
    expect((await overviewOn('2026-01-20'))!.eaten).toEqual({ meals: 3, of: 9 });
    // Before the plan begins nothing was due.
    expect((await overviewOn('2026-01-01'))!.eaten).toEqual({ meals: 0, of: 0 });
  });

  it('counts the meals of recipes the profile likes, and not those of one it marked to avoid', async () => {
    const plan = await planFrom('2026-01-05');
    const recipes = [
      ...new Set(plan.days.flatMap((day) => day.meals.map((meal) => meal.recipe!.id))),
    ];
    const mark = (recipeId: string, sentiment: string) =>
      t
        .http()
        .post('/api/favorites')
        .set(as(user))
        .send({ profileId: profile.id, recipeId, sentiment })
        .expect(201);
    const mealsOf = (recipeId: string): number =>
      plan.days.flatMap((day) => day.meals).filter((meal) => meal.recipe!.id === recipeId).length;

    await mark(recipes[0]!, 'often');
    await mark(recipes[1]!, 'avoid');

    expect((await overviewOn('2026-01-05'))!.favourites).toEqual({
      meals: mealsOf(recipes[0]!),
      of: 9,
    });
  });

  it("counts the entries of the plan's shopping lists and how many of them are ticked", async () => {
    const plan = await planFrom('2026-01-05');
    expect((await overviewOn('2026-01-05'))!.shopping).toEqual({ lists: 0, entries: 0, ticked: 0 });

    const list = (
      await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(user))
        .send({ planId: plan.id })
        .expect(201)
    ).body;
    const entries = list.groups.flatMap((group: { items: { id: string }[] }) => group.items);
    await t
      .http()
      .patch(`/api/shopping-lists/${list.id}/items/${entries[0].id}`)
      .set(as(user))
      .send({ checked: true })
      .expect(200);

    expect((await overviewOn('2026-01-05'))!.shopping).toEqual({
      lists: 1,
      entries: entries.length,
      ticked: 1,
    });
  });

  it('is answered over HTTP to the account it belongs to, by the day of whoever asks, and to nobody else', async () => {
    const other = await aUser(t);
    const plan = await planFrom('2026-01-05');
    const ask = (as_: TestUser, query: Record<string, string>) =>
      t.http().get('/api/meal-plans/overview').query(query).set(as(as_));

    // January is long past for the server: the plan that ended last.
    const answered = await ask(user, { profileId: profile.id }).expect(200);
    const refused = await ask(other, { profileId: profile.id }).expect(404);
    const unnamed = await ask(user, {}).expect(400);

    expect(answered.body.overview.plan).toMatchObject({ id: plan.id, status: 'past' });
    expect(refused.body.error).toBe('PROFILE_NOT_FOUND');
    expect(unnamed.body.issues[0].path).toBe('profileId');
  });
});
