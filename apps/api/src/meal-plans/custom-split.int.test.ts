// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { macrosForCalories, sharesOf } from '../engine/index.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('a plan for the custom diet', () => {
  let t: TestApp;
  let user: TestUser;

  const OWN = { protein: 30, fat: 40, carbs: 30 };
  const OTHER = { protein: 20, fat: 30, carbs: 50 };

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

  /** What a plan and each of its days aim at, when they aim at `split`. */
  const aimsAt = (plan: MealPlan, split: typeof OWN): void => {
    for (const day of plan.days) expect(day.targetMacros).toEqual(macrosForCalories(day.calorieTarget, 'custom', sharesOf(split)));
    expect(plan.days.length).toBeGreaterThan(0);
  };
  const changeSplit = (profile: Profile, customMacroSplit: typeof OWN) =>
    t.http().put(`/api/profiles/${profile.id}`).set(as(user)).send({ ...profile, id: undefined, userId: undefined, riskAcknowledgedAt: undefined, createdAt: undefined, updatedAt: undefined, customMacroSplit }).expect(200);
  const again = (plan: MealPlan, body?: Record<string, unknown>): Promise<MealPlan> =>
    t.http().post(`/api/meal-plans/${plan.id}/regenerate`).set(as(user)).send(body).expect(201).then((res) => res.body as MealPlan);

  it('aims at the split its profile said, on every day', async () => {
    const profile = await aProfile(t, user, { dietType: 'custom', customMacroSplit: OWN });

    const plan = await aPlan(t, user, profile);

    expect(plan.dietType).toBe('custom');
    aimsAt(plan, OWN);
    // 30 %, 40 % and 30 % are not the balanced diet's 25, 30 and 45.
    expect(plan.days[0]!.targetMacros).not.toEqual(macrosForCalories(plan.days[0]!.calorieTarget, 'balanced'));
  });

  it('can be asked for by a profile on another diet that has said its split', async () => {
    const profile = await aProfile(t, user, { dietType: 'vegan', customMacroSplit: OWN });

    const plan = await aPlan(t, user, profile, { dietType: 'custom' });

    expect(plan.dietType).toBe('custom');
    aimsAt(plan, OWN);
  });

  it('is refused for a profile that has said no split, and none is made', async () => {
    const profile = await aProfile(t, user);

    const refused = await t.http().post('/api/meal-plans/generate').set(as(user)).send({ profileId: profile.id, startDate: '2026-01-05', durationDays: 3, dietType: 'custom' }).expect(400);

    expect(refused.body.error).toBe('CUSTOM_SPLIT_MISSING');
    expect(await t.prisma.mealPlan.count()).toBe(0);
  });

  it('keeps the split it was made with while the profile changes its own', async () => {
    const profile = await aProfile(t, user, { dietType: 'custom', customMacroSplit: OWN });
    const plan = await aPlan(t, user, profile);

    await changeSplit(profile, OTHER);

    aimsAt((await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200)).body, OWN);
  });

  it('takes the profile\'s split of the day when the whole of it is made again, and keeps its own when days of it are', async () => {
    const profile = await aProfile(t, user, { dietType: 'custom', customMacroSplit: OWN });
    const plan = await aPlan(t, user, profile);
    await changeSplit(profile, OTHER);

    // Days of it: the plan stays what it is.
    aimsAt(await again(plan, { from: '2026-01-06', to: '2026-01-07' }), OWN);
    // The whole of it: as it was asked for, with the profile as it is now.
    aimsAt(await again(plan), OTHER);
  });

  it('has no split of its own on any other diet', async () => {
    const profile = await aProfile(t, user, { dietType: 'vegan', customMacroSplit: OWN });

    const plan = await aPlan(t, user, profile);

    expect(plan.days[0]!.targetMacros).toEqual(macrosForCalories(plan.days[0]!.calorieTarget, 'vegan'));
    expect((await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } })).macroSplit).toBeNull();
  });
});
