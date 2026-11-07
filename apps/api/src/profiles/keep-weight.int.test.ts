// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { dayAfter, ProfileInput, type MealPlan, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('a profile that reached the weight it works towards', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);

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
    profile = await aProfile(t, user, {
      age: 37,
      heightCm: 190,
      weightKg: 86,
      targetWeightKg: 85,
      activityLevel: 'sedentary',
      weeklyLossTarget: '0.5',
    });
  });

  const read = async (): Promise<Profile> =>
    (await t.http().get(`/api/profiles/${profile.id}`).set(as(user)).expect(200)).body;
  const weigh = (kg: number) =>
    t.http().post('/api/weights').set(as(user)).send({ profileId: profile.id, kg }).expect(201);
  const act = (path: string, expected = 200) =>
    t
      .http()
      .post(`/api/profiles/${profile.id}/${path}`)
      .set(as(user))
      .set('X-Client-Date', today)
      .expect(expected);

  it('says so once the newest weight comes down to it, and keeps the weight at a press', async () => {
    expect((await read()).targetWeightReached).toBe(false);
    await weigh(85);
    expect(await read()).toMatchObject({ weightKg: 85, targetWeightReached: true });

    const kept = (await act('keep-weight')).body as Profile;
    expect(kept).toMatchObject({ weeklyLossTarget: null, targetWeightReached: false });
    // The target is maintenance now.
    const calories = (
      await t.http().get(`/api/profiles/${profile.id}/calories`).set(as(user)).expect(200)
    ).body as { dailyTarget: number; maintenance: number };
    expect(calories.dailyTarget).toBe(calories.maintenance);
  });

  it('puts the offer off for two weeks', async () => {
    await weigh(84.5);
    expect((await act('keep-weight/later')).body).toMatchObject({
      targetWeightReached: true,
      targetReachedLaterUntil: dayAfter(today, 14),
      weeklyLossTarget: '0.5',
    });
  });

  it('says nothing to a profile whose target was typed, or that already keeps its weight', async () => {
    await weigh(84);
    const save = (change: Record<string, unknown>) =>
      t
        .http()
        .put(`/api/profiles/${profile.id}`)
        .set(as(user))
        .send({ ...ProfileInput.parse({ ...profile, weightKg: 84 }), ...change })
        .expect(200);
    expect(((await save({ manualCalorieTarget: 2200 })).body as Profile).targetWeightReached).toBe(
      false,
    );
    expect(
      ((await save({ manualCalorieTarget: null, weeklyLossTarget: null })).body as Profile)
        .targetWeightReached,
    ).toBe(false);
  });

  it('leaves a running plan to offer the target of keeping the weight from today', async () => {
    const plan = (
      await t
        .http()
        .post('/api/meal-plans/generate')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ profileId: profile.id, startDate: today, durationDays: 3 })
        .expect(201)
    ).body as MealPlan;
    await weigh(85);
    await act('keep-weight');

    const told = (
      await t
        .http()
        .get(`/api/meal-plans/${plan.id}`)
        .set(as(user))
        .set('X-Client-Date', today)
        .expect(200)
    ).body as MealPlan;
    expect(told.targetMoved).toMatchObject({ planTarget: plan.weeks[0]!.target });
    expect(told.targetMoved!.profileTarget).toBeGreaterThan(plan.weeks[0]!.target);
  });
});
