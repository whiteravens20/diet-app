// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  dayAfter,
  DEFAULT_WATER_TARGET_ML,
  GLASS_ML,
  MAX_WATER_ENTRIES_A_DAY,
  type Profile,
  type WaterDay,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the water a profile drinks', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);

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
    profile = await aProfile(t, user);
  });

  const add = (ml: number, day = today, expected = 201) =>
    t
      .http()
      .post('/api/water')
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ profileId: profile.id, day, ml })
      .expect(expected);
  const dayOf = async (day = today): Promise<WaterDay> =>
    (await t.http().get(`/api/water?profileId=${profile.id}&day=${day}`).set(as(user)).expect(200))
      .body;

  it("adds glasses and amounts to a day, takes a glass back, and says the day against the profile's target", async () => {
    expect(profile.waterTargetMl).toBe(DEFAULT_WATER_TARGET_ML);
    expect(await dayOf()).toEqual({ day: today, ml: 0, target: 2000, entries: 0 });

    await add(GLASS_ML);
    await add(GLASS_ML);
    const after = (await add(330)).body as WaterDay;
    expect(after).toEqual({ day: today, ml: 830, target: 2000, entries: 3 });

    expect(((await add(-GLASS_ML)).body as WaterDay).ml).toBe(580);
    // Another day is a day of its own.
    expect((await dayOf(dayAfter(today, -1))).ml).toBe(0);
  });

  it('refuses to take back more than a day holds, and a day that is full', async () => {
    await add(GLASS_ML);
    const refused = await add(-500, today, 409);
    expect(refused.body.error).toBe('WATER_BELOW_ZERO');
    expect((await dayOf()).ml).toBe(250);

    await t.prisma.waterEntry.createMany({
      data: Array.from({ length: MAX_WATER_ENTRIES_A_DAY - 1 }, () => ({
        profileId: profile.id,
        day: new Date(today),
        ml: 10,
      })),
    });
    expect((await add(GLASS_ML, today, 409)).body.error).toBe('WATER_DAY_FULL');
  });

  it('takes today and the year before it, as the diary does', async () => {
    expect((await add(GLASS_ML, dayAfter(today, 1), 409)).body.error).toBe('DIARY_DAY_AHEAD');
    expect((await add(GLASS_ML, dayAfter(today, -367), 409)).body.error).toBe('DIARY_DAY_TOO_OLD');
    await add(GLASS_ML, dayAfter(today, -366));
  });

  it('writes an entry sent again under its key once', async () => {
    const send = () =>
      t
        .http()
        .post('/api/water')
        .set(as(user))
        .set('X-Client-Date', today)
        .set('Idempotency-Key', 'water-key-1')
        .send({ profileId: profile.id, day: today, ml: GLASS_ML })
        .expect(201);
    await send();
    expect(((await send()).body as WaterDay).ml).toBe(GLASS_ML);
    expect((await dayOf()).entries).toBe(1);
  });

  it("keeps a profile's own target, or none, and leaves it where a client sends none", async () => {
    // The profile as a client sends it back: every part of it but what only the API writes.
    const body: Record<string, unknown> = { ...profile };
    for (const key of ['id', 'userId', 'createdAt', 'updatedAt', 'riskAcknowledgedAt', 'calories'])
      delete body[key];
    const put = (changes: Record<string, unknown>) =>
      t
        .http()
        .put(`/api/profiles/${profile.id}`)
        .set(as(user))
        .send({ ...body, ...changes })
        .expect(200);

    expect((await put({ waterTargetMl: 1500 })).body.waterTargetMl).toBe(1500);
    const without = { ...body };
    delete without.waterTargetMl;
    const kept = await t
      .http()
      .put(`/api/profiles/${profile.id}`)
      .set(as(user))
      .send(without)
      .expect(200);
    expect(kept.body.waterTargetMl).toBe(1500);
    expect((await put({ waterTargetMl: null })).body.waterTargetMl).toBeNull();
    expect((await dayOf()).target).toBeNull();
  });

  it("is none of another account's business", async () => {
    const other = await aUser(t);
    await t
      .http()
      .post('/api/water')
      .set(as(other))
      .send({ profileId: profile.id, day: today, ml: GLASS_ML })
      .expect(404);
    await t
      .http()
      .get(`/api/water?profileId=${profile.id}&day=${today}`)
      .set(as(other))
      .expect(404);
  });
});
