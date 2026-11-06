// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { CalorieCalculation, Profile, WeightEntry } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe("the profile's weight and the weight log", () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    // 37 years, 190 cm, 91 kg, sedentary, half a kilogram a week.
    profile = await aProfile(t, user, {
      age: 37,
      heightCm: 190,
      weightKg: 91,
      activityLevel: 'sedentary',
      weeklyLossTarget: '0.5',
    });
  });

  const log = async (kg: number, daysAgo = 0): Promise<WeightEntry> =>
    (
      await t
        .http()
        .post('/api/weights')
        .set(as(user))
        .send({
          profileId: profile.id,
          kg,
          ...(daysAgo
            ? { recordedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() }
            : {}),
        })
        .expect(201)
    ).body;
  const weight = async (): Promise<number> =>
    (await t.http().get(`/api/profiles/${profile.id}`).set(as(user)).expect(200)).body.weightKg;
  const calories = async (): Promise<CalorieCalculation> =>
    (await t.http().get(`/api/profiles/${profile.id}/calories`).set(as(user)).expect(200)).body;

  it("makes the newest weight the profile's, and works the calorie target out from it", async () => {
    const before = await calories();

    await log(81);

    expect(await weight()).toBe(81);
    // Ten kilograms less: 100 kcal less at rest, 140 less to maintain, the same deficit taken from it.
    expect(await calories()).toMatchObject({
      bmr: before.bmr - 100,
      maintenance: before.maintenance - 140,
      dailyDeficit: 550,
      dailyTarget: before.dailyTarget - 140,
    });
  });

  it("leaves the profile's weight alone for a weight logged for an earlier day", async () => {
    await log(85);
    await log(88, 3);

    expect(await weight()).toBe(85);
  });

  it('gives the profile the weight before the newest when the newest is removed, and keeps the last when none is left', async () => {
    const older = await log(88, 3);
    const newer = await log(85);

    await t.http().delete(`/api/weights/${newer.id}`).set(as(user)).expect(204);
    expect(await weight()).toBe(88);

    await t.http().delete(`/api/weights/${older.id}`).set(as(user)).expect(204);
    expect(await weight()).toBe(88);
  });

  it('changes nothing of the profile when an entry that is not the newest is removed', async () => {
    const older = await log(88, 3);
    await log(85);

    await t.http().delete(`/api/weights/${older.id}`).set(as(user)).expect(204);

    expect(await weight()).toBe(85);
  });
});
