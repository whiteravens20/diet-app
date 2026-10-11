// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('what a plan says about its days', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('a day the user skips', () => {
    it('is shown as skipped, is no shortfall, and is left out of the plan\'s average', async () => {
      const plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 3, dayOverrides: [{ date: '2026-01-06', skip: true }] });

      const [first, skipped, third] = plan.days;
      expect(skipped).toMatchObject({ skipped: true, meals: [], calorieDelta: 0 });
      expect([first!.skipped, third!.skipped]).toEqual([false, false]);
      const eaten = (first!.dayNutrition.calories + third!.dayNutrition.calories) / 2;
      expect(Math.abs(plan.averageDailyNutrition.calories - eaten)).toBeLessThanOrEqual(1);
    });
  });
});
