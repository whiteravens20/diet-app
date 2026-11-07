// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { dayAfter, type Profile, type WeekSummary } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY_MS = 86_400_000;

describe("what a profile's diary and weights come to", () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (days: number) => dayAfter(today, -days);

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
    // 37 years, 190 cm, 91 kg, sedentary, half a kilogram a week: maintenance 2685, target 2135.
    profile = await aProfile(t, user, {
      age: 37,
      heightCm: 190,
      weightKg: 91,
      activityLevel: 'sedentary',
      weeklyLossTarget: '0.5',
    });
  });

  const eat = (date: string, calories: number) =>
    t
      .http()
      .post('/api/diary/entries')
      .set(as(user))
      .set('X-Client-Date', today)
      .send({
        profileId: profile.id,
        date,
        mealType: 'lunch',
        kind: 'meal',
        name: 'Obiad',
        // A fifth of the energy from protein, three tenths from fat, half from carbohydrate.
        nutrition: {
          calories,
          protein: Math.round((calories * 0.2) / 4),
          fat: Math.round((calories * 0.3) / 9),
          carbs: Math.round((calories * 0.5) / 4),
        },
      })
      .expect(201);
  /** A weight noted so many days back, written as the log keeps it; the profile's own weight stays 91 kg. */
  const weigh = (days: number, kg: number) =>
    t.prisma.weightEntry.create({
      data: { profileId: profile.id, kg, recordedAt: new Date(Date.now() - days * DAY_MS) },
    });
  const get = async <T>(path: string): Promise<T> =>
    (await t.http().get(path).set(as(user)).set('X-Client-Date', today).expect(200)).body as T;
  describe('the week in sum', () => {
    it('averages the days that count against their targets, and names the empty ones', async () => {
      for (const [days, kcal] of [
        [1, 2135],
        [2, 2135],
        [3, 2400],
        [5, 2000],
        [7, 2200],
      ] as const)
        await eat(daysAgo(days), kcal);

      const week = await get<WeekSummary>(`/api/diary/week?profileId=${profile.id}`);
      expect(week).toMatchObject({ from: daysAgo(7), to: daysAgo(1), counted: 5, empty: 2 });
      expect(week.eaten?.calories).toBe(2174);
      expect(week.target?.calories).toBe(2135);
      // 2400 is more than a tenth over 2135; the rest are within it.
      expect(week.withinTarget).toBe(4);
    });

    it('says where the weights lead, and when they reach the target weight at this pace', async () => {
      await t.prisma.profile.update({ where: { id: profile.id }, data: { targetWeightKg: 85 } });
      for (const days of [27, 20, 13, 6]) await weigh(days, 91 + (days - 6) / 14 + 0.5);

      const { weight } = await get<WeekSummary>(`/api/diary/week?profileId=${profile.id}`);
      expect(weight.kgPerWeek).toBeCloseTo(-0.5, 1);
      expect(weight.targetKg).toBe(85);
      // About 6 kg to go at half a kilogram a week: some twelve weeks after yesterday.
      const ahead = (Date.parse(weight.reachesTargetOn!) - Date.parse(daysAgo(1))) / DAY_MS;
      expect(ahead).toBeGreaterThan(75);
      expect(ahead).toBeLessThan(95);
    });

    it('draws no line from too few weights, and goes back a week when asked', async () => {
      await weigh(3, 90.5);
      await weigh(1, 90.2);
      const week = await get<WeekSummary>(
        `/api/diary/week?profileId=${profile.id}&to=${daysAgo(8)}`,
      );
      expect(week).toMatchObject({ from: daysAgo(14), to: daysAgo(8), counted: 0, empty: 7 });
      expect(week.eaten).toBeNull();
      expect(week.weight.kgPerWeek).toBeNull();
    });
  });
});
