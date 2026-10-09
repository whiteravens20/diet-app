// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

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

  // Known defect: nothing serialises two regenerations of one plan, so each
  // overlapping pair leaves every day twice. `fails` keeps the suite green while
  // the defect exists and turns red the moment it is fixed, which is the signal
  // to make this an ordinary test.
  it.fails('keeps one day per date when two requests overlap', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 28 });
    const plans = t.app.get(MealPlansService);

    for (let round = 0; round < 2; round += 1) {
      await race(2, () => plans.regenerate(user.id, 'en', plan.id));
    }

    expect(await t.prisma.mealPlanDay.count({ where: { planId: plan.id } })).toBe(28);
  });
});
