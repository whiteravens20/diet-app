// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  dayAfter,
  DEFAULT_WATER_TARGET_ML,
  MAX_WATER_ENTRIES_A_DAY,
  WATER_AMOUNTS_ML,
  type Profile,
  type WaterDay,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/** A glass, what the first button adds. */
const GLASS = WATER_AMOUNTS_ML[0];

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
  const remove = (id: string, expected = 200) =>
    t.http().delete(`/api/water/${id}`).set(as(user)).expect(expected);

  it("adds the amounts pressed or typed to a day, and says the day against the profile's target", async () => {
    expect(profile.waterTargetMl).toBe(DEFAULT_WATER_TARGET_ML);
    expect(await dayOf()).toMatchObject({
      day: today,
      ml: 0,
      target: 2000,
      entries: 0,
      last: null,
    });

    for (const ml of WATER_AMOUNTS_ML) await add(ml);
    const after = (await add(120)).body as WaterDay;
    expect(after).toMatchObject({ day: today, ml: 1200, target: 2000, entries: 4 });
    expect(after.last).toMatchObject({ ml: 120 });
    // Another day is a day of its own.
    expect((await dayOf(dayAfter(today, -1))).ml).toBe(0);
  });

  it('takes no amount that is not water added, and no more entries than a day holds', async () => {
    for (const ml of [0, -250, 5001, 2.5]) await add(ml, today, 400);
    await t.prisma.waterEntry.createMany({
      data: Array.from({ length: MAX_WATER_ENTRIES_A_DAY }, () => ({
        profileId: profile.id,
        day: new Date(today),
        ml: 10,
      })),
    });
    expect((await add(GLASS, today, 409)).body.error).toBe('WATER_DAY_FULL');
  });

  it('removes the entry written last, and then the one before it', async () => {
    await add(GLASS);
    await add(500);
    const written = await dayOf();
    expect(written.last).toMatchObject({ ml: 500 });

    const removed = (await remove(written.last!.id)).body as WaterDay;
    expect(removed).toMatchObject({ ml: GLASS, entries: 1, last: { ml: GLASS } });
    expect((await remove(removed.last!.id)).body).toMatchObject({ ml: 0, entries: 0, last: null });
    expect((await remove(written.last!.id, 404)).body.error).toBe('WATER_ENTRY_NOT_FOUND');
  });

  it('brings the seven days that end with the day asked for, oldest first', async () => {
    await add(GLASS, dayAfter(today, -6));
    await add(330, dayAfter(today, -2));
    await add(500, dayAfter(today, -2));
    // A day before the seven is not among them.
    await add(GLASS, dayAfter(today, -7));

    const { days } = await dayOf();
    expect(days.map((d) => d.day)).toEqual(
      Array.from({ length: 7 }, (_, at) => dayAfter(today, at - 6)),
    );
    expect(days.map((d) => d.ml)).toEqual([250, 0, 0, 0, 830, 0, 0]);
    expect((await dayOf(dayAfter(today, -2))).days.at(-1)).toEqual({
      day: dayAfter(today, -2),
      ml: 830,
    });
  });

  it('takes today and the year before it, as the diary does', async () => {
    expect((await add(GLASS, dayAfter(today, 1), 409)).body.error).toBe('DIARY_DAY_AHEAD');
    expect((await add(GLASS, dayAfter(today, -367), 409)).body.error).toBe('DIARY_DAY_TOO_OLD');
    await add(GLASS, dayAfter(today, -366));
  });

  it('writes an entry sent again under its key once', async () => {
    const send = () =>
      t
        .http()
        .post('/api/water')
        .set(as(user))
        .set('X-Client-Date', today)
        .set('Idempotency-Key', 'water-key-1')
        .send({ profileId: profile.id, day: today, ml: GLASS })
        .expect(201);
    await send();
    expect(((await send()).body as WaterDay).ml).toBe(GLASS);
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
      .send({ profileId: profile.id, day: today, ml: GLASS })
      .expect(404);
    await t
      .http()
      .get(`/api/water?profileId=${profile.id}&day=${today}`)
      .set(as(other))
      .expect(404);
    const { last } = (await add(GLASS)).body as WaterDay;
    const refused = await t.http().delete(`/api/water/${last!.id}`).set(as(other)).expect(404);
    expect(refused.body.error).toBe('WATER_ENTRY_NOT_FOUND');
    expect((await dayOf()).ml).toBe(GLASS);
  });
});
