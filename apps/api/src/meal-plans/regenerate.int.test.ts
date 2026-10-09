// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, race } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

describe('regenerating a plan', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('replaces the meals and keeps one day per date', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 14 });

    const regenerated = await t.app.get(MealPlansService).regenerate(user.id, 'en', plan.id);

    expect(regenerated.days.map((day) => day.date)).toEqual(plan.days.map((day) => day.date));
    expect(await t.prisma.mealPlanDay.count({ where: { planId: plan.id } })).toBe(14);
  });

  it('advances the revision by one for each change', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));
    const plans = t.app.get(MealPlansService);
    expect(plan.revision).toBe(0);

    const once = await plans.regenerate(user.id, 'en', plan.id);
    const twice = await plans.regenerateDay(user.id, 'en', plan.id, once.days[0]!.id);

    expect(once.revision).toBe(1);
    expect(twice.revision).toBe(2);
  });

  it('keeps one day per date when two regenerations overlap', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 28 });
    const plans = t.app.get(MealPlansService);

    for (let round = 0; round < 3; round += 1) {
      const results = await race(2, () => plans.regenerate(user.id, 'en', plan.id));

      // One request wins. The other is told the plan changed; it never writes.
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(refusals(results)).toEqual(['PLAN_CHANGED']);
      expect(await t.prisma.mealPlanDay.count({ where: { planId: plan.id } })).toBe(28);
    }
    expect((await plans.get(user.id, 'en', plan.id)).revision).toBe(3);
  });

  it('keeps one meal per slot when two re-rolls of a day overlap', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));
    const plans = t.app.get(MealPlansService);
    const day = plan.days[2]!;

    const results = await race(2, () => plans.regenerateDay(user.id, 'en', plan.id, day.id));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refusals(results)).toEqual(['PLAN_CHANGED']);
    const meals = await t.prisma.plannedMeal.findMany({ where: { dayId: day.id } });
    expect(meals.map((m) => m.mealType).sort()).toEqual(['breakfast', 'dinner', 'lunch']);
  });

  it('answers 409 over HTTP to a change computed from an older revision', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));

    const results = await race(2, () =>
      t.app.get(MealPlansService).regenerate(user.id, 'en', plan.id),
    );
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;

    expect(refused.reason).toBeInstanceOf(HttpException);
    expect((refused.reason as HttpException).getStatus()).toBe(409);
  });

  it('refuses a second day for a date the plan already has', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));

    await expect(
      t.prisma.mealPlanDay.create({
        data: { planId: plan.id, date: new Date(plan.days[0]!.date), calorieTarget: 2000 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

/** The error codes of the requests that were refused. */
function refusals(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => {
      const response = r.reason instanceof HttpException ? r.reason.getResponse() : undefined;
      return typeof response === 'object' && response !== null && 'error' in response
        ? String(response.error)
        : String(r.reason);
    });
}
