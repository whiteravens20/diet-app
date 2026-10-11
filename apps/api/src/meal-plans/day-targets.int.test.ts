// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { CalorieCalculation, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

describe('the calorie target of a profile, and of the days of its plans', () => {
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

  const calories = async (profile: Profile): Promise<CalorieCalculation> => (await t.http().get(`/api/profiles/${profile.id}/calories`).set(as(user)).expect(200)).body;
  const targets = (plan: { days: { calorieTarget: number }[] }) => plan.days.map((day) => day.calorieTarget);
  /** Three days from the plan's first: a normal one, a rest day, a training day. */
  const threeKinds = { durationDays: 3, dayOverrides: [{ date: '2026-01-06', dayType: 'rest' as const }, { date: '2026-01-07', dayType: 'training' as const }] };

  describe('somebody whose calculated target is the floor', () => {
    // 70 years, 155 cm, 55 kg, sedentary: maintenance 1210, the floor for a woman 1200.
    const onTheFloor = () => aProfile(t, user, { age: 70, sex: 'female', heightCm: 155, weightKg: 55, activityLevel: 'sedentary', weeklyLossTarget: '1.0' });

    it('is told the real deficit, that the pace was slowed and that the floor was applied', async () => {
      expect(await calories(await onTheFloor())).toMatchObject({
        maintenance: 1210,
        dailyTarget: 1200,
        requestedDeficit: 1100,
        dailyDeficit: 10,
        safetyFloor: 1200,
        deficitCapped: true,
        safetyFloorApplied: true,
        maintenanceUnderFloor: false,
      });
    });

    it('is not planned under the floor on a rest day, when the plan is made and when it is made again', async () => {
      const plan = await aPlan(t, user, await onTheFloor(), threeKinds);
      expect(targets(plan)).toEqual([1200, 1200, 1380]);

      expect(targets(await t.app.get(MealPlansService).regenerate(user.id, 'en', plan.id))).toEqual([1200, 1200, 1380]);
    });

    it('is followed by a rest day when they typed a target for the plan, down to the least a target may be and no further', async () => {
      const plan = await aPlan(t, user, await onTheFloor(), { ...threeKinds, calorieTargetOverride: 800 });

      // 800 × 0.85 would be 680.
      expect(targets(plan)).toEqual([800, 800, 920]);
    });

    it('gets the target they set for one day as they set it', async () => {
      const plan = await aPlan(t, user, await onTheFloor(), { durationDays: 2, dayOverrides: [{ date: '2026-01-06', dayType: 'rest', calorieTarget: 950 }] });

      expect(targets(plan)).toEqual([1200, 950]);
    });
  });
});
