// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ProfileTargetsFill } from './profile-targets-fill.js';
import { HeldTarget, TARGET_COLUMNS, targetOf } from './profile-targets.js';

describe('what a profile aims at, written down', () => {
  let t: TestApp;
  let user: TestUser;
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
  });

  const rowsOf = async (profileId: string) =>
    (await t.prisma.profileTarget.findMany({ where: { profileId }, orderBy: { from: 'asc' } })).map(
      (row) => ({
        from: row.from.toISOString().slice(0, 10),
        target: HeldTarget.parse(row.target),
      }),
    );
  const standing = async (profileId: string) =>
    targetOf(
      await t.prisma.profile.findUniqueOrThrow({
        where: { id: profileId },
        select: TARGET_COLUMNS,
      }),
    );

  it('from its first day when it is made', async () => {
    const profile = await aProfile(t, user);

    expect(await rowsOf(profile.id)).toEqual([{ from: today, target: await standing(profile.id) }]);
  });

  it('once a day it changes, the last change of the day standing', async () => {
    const profile = await aProfile(t, user);
    const weigh = (kg: number) =>
      t
        .http()
        .post('/api/weights')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ profileId: profile.id, kg })
        .expect(201);

    await weigh(75);
    await weigh(72);

    const rows = await rowsOf(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ from: today, target: await standing(profile.id) });
  });

  it('for a profile from before such rows, at the start, from its first day and once', async () => {
    const profile = await aProfile(t, user);
    await t.prisma.profileTarget.deleteMany({ where: { profileId: profile.id } });
    await t.prisma.profile.update({
      where: { id: profile.id },
      data: { createdAt: new Date('2026-09-01T10:00:00Z') },
    });
    const fill = t.app.get(ProfileTargetsFill);

    expect(await fill.fill()).toBe(1);
    expect(await rowsOf(profile.id)).toEqual([
      { from: '2026-09-01', target: await standing(profile.id) },
    ]);
    // A second start finds every profile with its row.
    expect(await fill.fill()).toBe(0);
  });

  it('goes with its profile', async () => {
    const profile = await aProfile(t, user);

    await t.http().delete(`/api/profiles/${profile.id}`).set(as(user)).expect(204);

    expect(await t.prisma.profileTarget.count({ where: { profileId: profile.id } })).toBe(0);
  });
});
