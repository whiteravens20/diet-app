// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { CalorieCalculation, MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe("the custom diet's protein per kilogram", () => {
  let t: TestApp;
  let user: TestUser;

  /** The split whose fat the way keeps; its protein and carbohydrate give way to the grams of the weight. */
  const SPLIT = { protein: 25, fat: 30, carbs: 45 };
  /** 1.6 g a kilogram of 80 kg: 128 g, 512 kcal of a target of 2400. */
  const OWN = {
    dietType: 'custom',
    customMacroSplit: SPLIT,
    customProteinPerKg: 1.6,
    manualCalorieTarget: 2400,
  } as const;

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
  });

  const calories = async (profile: Profile): Promise<CalorieCalculation> =>
    (await t.http().get(`/api/profiles/${profile.id}/calories`).set(as(user)).expect(200)).body;
  const patch = (profile: Profile, body: Record<string, unknown>) =>
    t.http().patch(`/api/profiles/${profile.id}`).set(as(user)).send(body);
  const grams = (plan: MealPlan) => plan.days.map((day) => day.targetMacros.protein);

  it("aims the profile's target at the grams of protein its weight gives, fat at its share and carbohydrate at the rest", async () => {
    const profile = await aProfile(t, user, OWN);

    const calculation = await calories(profile);

    // 2400 kcal: 128 g of protein (512 kcal), 30 % fat (720 kcal, 80 g), the rest 1168 kcal of carbohydrate.
    expect(calculation.targetMacros).toEqual({
      protein: 128,
      fat: 80,
      carbs: 292,
      carbsFloor: null,
    });
    expect(calculation.customSplitHeld).toBe(false);
    // A client that reads the split alone is told what the grams come to, in whole per cent.
    expect(profile.customProteinPerKg).toBe(1.6);
    expect(profile.customMacroSplit).toEqual({ protein: 21, fat: 30, carbs: 49 });
  });

  it('follows the weight', async () => {
    const profile = await aProfile(t, user, OWN);

    await patch(profile, { weightKg: 90 }).expect(200);

    expect((await calories(profile)).targetMacros.protein).toBe(144);
  });

  it('is refused where the grams take a share past a limit, the fitting grams named, and the profile stays', async () => {
    const profile = await aProfile(t, user, OWN);

    // 3 g a kilogram of 80 kg is 960 kcal: 40 % of 2400, inside; of 1800, 53 %, past the 45 %.
    const refused = await patch(profile, {
      customProteinPerKg: 3,
      manualCalorieTarget: 1800,
    }).expect(400);

    expect(refused.body.error).toBe('VALIDATION_FAILED');
    expect(refused.body.issues[0].path).toBe('customProteinPerKg');
    expect(refused.body.issues[0].message).toContain('fits from 0.8 to 2.5 g');
    const kept = (await t.http().get(`/api/profiles/${profile.id}`).set(as(user)).expect(200))
      .body as Profile;
    expect(kept.customProteinPerKg).toBe(1.6);
    expect(kept.manualCalorieTarget).toBe(2400);
  });

  it('is refused where a change of the share of fat takes the grams past a limit', async () => {
    const profile = await aProfile(t, user, { ...OWN, customProteinPerKg: 3 });

    // 3 g a kilogram of 80 kg is 40 % of 2400 kcal: with fat at 60 % carbohydrate would have nothing.
    const refused = await patch(profile, {
      customMacroSplit: { protein: 35, fat: 60, carbs: 5 },
      customProteinPerKg: 3,
    }).expect(400);

    expect(refused.body.issues[0].path).toBe('customProteinPerKg');
  });

  it.each([
    // 3 g a kilogram of 80 kg is 960 kcal: 40 % of 2400, 53 % of 1800.
    ['a lower target', { manualCalorieTarget: 1800 }, 1800],
    // 3 g a kilogram of 150 kg is 1800 kcal: 75 % of 2400.
    ['a heavier body', { weightKg: 150 }, 2400],
  ])(
    'is held at the limit where %s takes it past one, and the profile says so',
    async (_, change, target) => {
      const profile = await aProfile(t, user, { ...OWN, customProteinPerKg: 3 });

      const changed = (await patch(profile, change).expect(200)).body as Profile;

      expect(changed.customProteinPerKg).toBe(3);
      const calculation = await calories(profile);
      expect(calculation.customSplitHeld).toBe(true);
      // Protein is held at 45 % of the day.
      expect(Math.abs(calculation.targetMacros.protein - (target * 0.45) / 4)).toBeLessThanOrEqual(
        0.5,
      );
    },
  );

  it('goes back to the custom diet with the targets a profile kept on another, held where the body has changed since', async () => {
    const profile = await aProfile(t, user, {
      ...OWN,
      dietType: 'balanced',
      customProteinPerKg: 3,
    });
    await patch(profile, { weightKg: 150 }).expect(200);

    // As a form sends the custom diet with the targets the profile keeps for it.
    await patch(profile, {
      dietType: 'custom',
      customMacroSplit: SPLIT,
      customProteinPerKg: 3,
    }).expect(200);

    expect((await calories(profile)).customSplitHeld).toBe(true);
  });

  it('is refused on a new profile as on a change', async () => {
    const refused = await t
      .http()
      .post('/api/profiles')
      .set(as(user))
      .send({
        name: 'Me',
        age: 30,
        sex: 'male',
        heightCm: 180,
        weightKg: 150,
        ...OWN,
        customProteinPerKg: 3,
      })
      .expect(400);

    expect(refused.body.issues[0].path).toBe('customProteinPerKg');
    expect(await t.prisma.profile.count()).toBe(0);
  });

  it("goes back to the split's way where a change names the split alone, as an older app sends it", async () => {
    const profile = await aProfile(t, user, OWN);

    const changed = (
      await patch(profile, { customMacroSplit: { protein: 30, fat: 30, carbs: 40 } }).expect(200)
    ).body as Profile;

    expect(changed.customProteinPerKg).toBeNull();
    expect(changed.customMacroSplit).toEqual({ protein: 30, fat: 30, carbs: 40 });
    expect((await calories(profile)).targetMacros.protein).toBe(180);
  });

  it('keeps the grams on every day of a plan made for it, whatever the calories of the day, fat at its share', async () => {
    const profile = await aProfile(t, user, OWN);

    const plan = await aPlan(t, user, profile, {
      dayOverrides: [
        { date: '2026-01-06', dayType: 'training' },
        { date: '2026-01-07', dayType: 'rest' },
        { date: '2026-01-08', calorieTarget: 3000 },
      ],
    });

    const targets = plan.days.map((day) => day.calorieTarget);
    expect(new Set(targets).size).toBeGreaterThan(2);
    expect(new Set(grams(plan))).toEqual(new Set([128]));
    for (const day of plan.days) {
      expect(day.targetMacros.fat).toBe(Math.round((day.calorieTarget * 0.3) / 9));
      expect(day.targetMacros.carbs).toBe(
        Math.round((day.calorieTarget - 512 - day.calorieTarget * 0.3) / 4),
      );
    }
  });

  it("keeps the grams it was made with while the profile's weight changes, and a plan made again takes the new ones", async () => {
    const profile = await aProfile(t, user, OWN);
    const plan = await aPlan(t, user, profile);

    await patch(profile, { weightKg: 90 }).expect(200);

    const read = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
      .body as MealPlan;
    expect(new Set(grams(read))).toEqual(new Set([128]));
    const again = (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/regenerate`)
        .set(as(user))
        .send({})
        .expect(201)
    ).body as MealPlan;
    expect(new Set(grams(again))).toEqual(new Set([144]));
  });
});
