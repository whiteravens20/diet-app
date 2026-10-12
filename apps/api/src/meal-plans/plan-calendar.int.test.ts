// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, PlanCalendarDay, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the days of a profile\'s plans in a span of days', () => {
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

  const ask = (asked: Record<string, string>, by: TestUser = user) => t.http().get('/api/meal-plans/calendar').query({ profileId: profile.id, ...asked }).set(as(by));
  const daysOf = async (from: string, to: string): Promise<PlanCalendarDay[]> => (await ask({ from, to }).expect(200)).body.days;
  const planFrom = (startDate: string, durationDays = 3, options: Record<string, unknown> = {}): Promise<MealPlan> => aPlan(t, user, profile, { startDate, durationDays, ...options });

  it('are none for a profile without a plan, and none in a span no plan reaches', async () => {
    expect(await daysOf('2026-01-01', '2026-01-31')).toEqual([]);

    await planFrom('2026-01-05');

    expect(await daysOf('2026-02-01', '2026-02-28')).toEqual([]);
  });

  it('are the days the plans hold, in order, each as the view of its plan has it', async () => {
    const second = await planFrom('2026-01-12', 2);
    const first = await planFrom('2026-01-05');

    const days = await daysOf('2025-12-29', '2026-02-08');

    expect(days.map((day) => day.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-12', '2026-01-13']);
    expect(days).toEqual(
      [...first.days, ...second.days].map((day, index) => ({
        date: day.date,
        planId: index < 3 ? first.id : second.id,
        plans: 1,
        calories: day.dayNutrition.calories,
        target: day.calorieTarget,
        offTarget: day.offTarget,
        eaten: { meals: 0, of: day.meals.length },
        skipped: false,
      })),
    );
  });

  it('are those of the span and no others: its first and last day are days of it', async () => {
    await planFrom('2026-01-05', 7);

    expect((await daysOf('2026-01-07', '2026-01-09')).map((day) => day.date)).toEqual(['2026-01-07', '2026-01-08', '2026-01-09']);
    expect((await daysOf('2026-01-11', '2026-01-11')).map((day) => day.date)).toEqual(['2026-01-11']);
    expect(await daysOf('2026-01-12', '2026-01-12')).toEqual([]);
  });

  it('count the meals that were marked as eaten', async () => {
    const plan = await planFrom('2026-01-05');
    const [monday] = plan.days;
    for (const meal of monday!.meals.slice(0, 2)) await t.http().patch(`/api/meal-plans/${plan.id}/meals/${meal.id}/eaten`).set(as(user)).send({ eaten: true }).expect(200);

    const days = await daysOf('2026-01-05', '2026-01-07');

    expect(days.map((day) => day.eaten)).toEqual([
      { meals: 2, of: 3 },
      { meals: 0, of: 3 },
      { meals: 0, of: 3 },
    ]);
  });

  it('say of a day the plan skips that it is skipped, and holds nothing', async () => {
    const plan = await planFrom('2026-01-05', 3, { dayOverrides: [{ date: '2026-01-06', skip: true }] });

    const [, tuesday] = await daysOf('2026-01-05', '2026-01-07');

    expect(tuesday).toMatchObject({ date: '2026-01-06', planId: plan.id, skipped: true, calories: 0, offTarget: null, eaten: { meals: 0, of: 0 } });
  });

  it('say where a day stands outside the tenth either side of its target, as the plan says it', async () => {
    const plan = await planFrom('2026-01-05');
    const [monday] = plan.days;
    // A meal of 2,000 kcal on top of a day that was at its target.
    await t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${monday!.date}/custom-meal`)
      .set(as(user))
      .send({ name: 'Feast', mealType: 'snack', nutrition: { calories: 2000, protein: 50, fat: 80, carbs: 250 }, servings: 1 })
      .expect(201);
    const after: MealPlan = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200)).body;

    const [first] = await daysOf('2026-01-05', '2026-01-05');

    expect(first).toMatchObject({ calories: after.days[0]!.dayNutrition.calories, offTarget: after.days[0]!.offTarget, eaten: { of: after.days[0]!.meals.length } });
    expect(after.days[0]!.meals.some((meal) => meal.source === 'USER_CUSTOM')).toBe(true);
  });

  it('give a day that several plans hold to the plan made last, and say how many hold it', async () => {
    const earlier = await planFrom('2026-01-05');
    const later = await planFrom('2026-01-06', 2);

    const days = await daysOf('2026-01-05', '2026-01-08');

    expect(days.map((day) => [day.date, day.planId, day.plans])).toEqual([
      ['2026-01-05', earlier.id, 1],
      ['2026-01-06', later.id, 2],
      ['2026-01-07', later.id, 2],
    ]);
  });

  it('read one day of a plan for each day of the span, however many plans hold it', async () => {
    for (let made = 0; made < 4; made += 1) await planFrom('2026-01-05', 2);
    const read = vi.spyOn(t.prisma.mealPlanDay, 'findMany');

    const days = await daysOf('2026-01-05', '2026-01-06');

    expect(days.map((day) => day.plans)).toEqual([4, 4]);
    expect(read).toHaveBeenCalledTimes(1);
    expect((read.mock.calls[0]![0] as { where: { id: { in: string[] } } }).where.id.in).toHaveLength(2);
    read.mockRestore();
  });

  describe('are asked for', () => {
    it('by the account the profile belongs to, and by nobody else', async () => {
      const other = await aUser(t);
      await planFrom('2026-01-05');

      const refused = await ask({ from: '2026-01-05', to: '2026-01-07' }, other).expect(404);
      await t.http().get('/api/meal-plans/calendar').query({ profileId: profile.id, from: '2026-01-05', to: '2026-01-07' }).expect(401);

      expect(refused.body.error).toBe('PROFILE_NOT_FOUND');
    });

    it.each([
      ['without a first day', { to: '2026-01-07' }, 'from'],
      ['without a last day', { from: '2026-01-05' }, 'to'],
      ['with a last day before the first', { from: '2026-01-07', to: '2026-01-05' }, 'to'],
      ['with a day there is not', { from: '2026-02-30', to: '2026-03-05' }, 'from'],
      ['for more days than the six weeks a month is drawn in', { from: '2026-01-01', to: '2026-02-12' }, 'to'],
    ])('and refused %s', async (_how, asked, path) => {
      const refused = await ask(asked).expect(400);

      expect(refused.body.error).toBe('VALIDATION_FAILED');
      expect(refused.body.issues[0].path).toBe(path);
    });

    it('for as many days as six weeks have, and for no profile left unnamed', async () => {
      await ask({ from: '2026-01-01', to: '2026-02-11' }).expect(200);
      const unnamed = await t.http().get('/api/meal-plans/calendar').query({ from: '2026-01-01', to: '2026-01-07' }).set(as(user)).expect(400);

      expect(unnamed.body.issues[0].path).toBe('profileId');
    });
  });
});
