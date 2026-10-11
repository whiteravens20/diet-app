// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ProfileInput, type CalorieCalculation, type Profile } from '@diet-app/shared';
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
  const save = async (profile: Profile, change: Record<string, unknown>): Promise<Profile> =>
    (await t.http().put(`/api/profiles/${profile.id}`).set(as(user)).send({ ...ProfileInput.parse(profile), ...change }).expect(200)).body;
  const targets = (plan: { days: { calorieTarget: number }[] }) => plan.days.map((day) => day.calorieTarget);
  /** A day's target is a round ten. */
  const toTen = (kcal: number) => Math.round(kcal / 10) * 10;
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
        goalHeld: false,
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

  describe('somebody under 18 or underweight who asks to lose weight', () => {
    // 16 years, 165 cm, 55 kg, moderately active: maintenance 2077.
    const aMinor = (over: Partial<ProfileInput> = {}) => aProfile(t, user, { age: 16, sex: 'female', heightCm: 165, weightKg: 55, weeklyLossTarget: '1.0', ...over });

    it('is planned maintenance, with the warning, until they say they understand the risk', async () => {
      const profile = await aMinor();
      expect(profile.riskAcknowledgedAt).toBeNull();

      const held = await calories(profile);
      expect(held).toMatchObject({ goalHeld: true, dailyTarget: held.maintenance, dailyDeficit: 0, warnings: ['minor'] });
      expect(targets(await aPlan(t, user, profile, { durationDays: 2 }))).toEqual([toTen(held.maintenance), toTen(held.maintenance)]);
    });

    it('cannot get under maintenance by typing a target for the plan or for a day', async () => {
      const profile = await aMinor();
      const { maintenance } = await calories(profile);

      const plan = await aPlan(t, user, profile, { durationDays: 2, calorieTargetOverride: 900, dayOverrides: [{ date: '2026-01-06', calorieTarget: 850 }] });

      expect(targets(plan)).toEqual([toTen(maintenance), toTen(maintenance)]);
    });

    it('gets the goal once they acknowledge it, within the limits everybody has, and can take the word back', async () => {
      const profile = await aMinor();

      const acknowledged = await save(profile, { acknowledgeRisk: true });
      expect(acknowledged.riskAcknowledgedAt).not.toBeNull();
      const applied = await calories(acknowledged);
      expect(applied).toMatchObject({ goalHeld: false, deficitCapped: true, warnings: ['minor'] });
      expect(applied.dailyTarget).toBe(applied.maintenance - Math.round(applied.maintenance * 0.25));

      // A save that says nothing about it keeps the word; one that says no takes it back.
      expect((await save(acknowledged, { name: 'Renamed' })).riskAcknowledgedAt).toBe(acknowledged.riskAcknowledgedAt);
      expect((await save(acknowledged, { acknowledgeRisk: false })).riskAcknowledgedAt).toBeNull();
      expect((await calories(acknowledged)).goalHeld).toBe(true);
    });

    it('has nothing to acknowledge once they are neither: the word is cleared', async () => {
      const acknowledged = await save(await aMinor(), { acknowledgeRisk: true });

      const grownUp = await save(acknowledged, { age: 18 });

      expect(grownUp.riskAcknowledgedAt).toBeNull();
      expect(await calories(grownUp)).toMatchObject({ goalHeld: false, warnings: [] });
    });

    it('is warned without being held when no loss is asked for', async () => {
      const profile = await aProfile(t, user, { age: 25, sex: 'female', heightCm: 170, weightKg: 50, weeklyLossTarget: null });

      expect(await calories(profile)).toMatchObject({ goalHeld: false, warnings: ['underweight'], dailyDeficit: 0 });
    });
  });

  it('stores no acknowledgement for somebody who has nothing to acknowledge', async () => {
    const profile = await aProfile(t, user, { acknowledgeRisk: true });

    expect(profile.riskAcknowledgedAt).toBeNull();
    expect(await calories(profile)).toMatchObject({ goalHeld: false, warnings: [], deficitCapped: false });
  });
});
