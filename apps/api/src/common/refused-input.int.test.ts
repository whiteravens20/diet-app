// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/** What no request may hold is refused as a field is, and never answered as a failure of the server. */
describe('a request that holds what no request may', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  afterAll(async () => {
    await t.close();
  });

  const NUL = 'a\u0000b';
  const refusedAt = (body: { error: string; issues?: { path: string }[] }) => ({
    error: body.error,
    paths: (body.issues ?? []).map((issue) => issue.path),
  });

  it('is refused with the field named where a text holds a NUL character: a body, a query, a sign-up', async () => {
    const renamed = await t
      .http()
      .patch(`/api/profiles/${profile.id}`)
      .set(as(user))
      .send({ name: NUL })
      .expect(400);
    expect(refusedAt(renamed.body)).toEqual({ error: 'VALIDATION_FAILED', paths: ['name'] });

    const searched = await t
      .http()
      .get(`/api/recipes?search=${encodeURIComponent(NUL)}`)
      .set(as(user))
      .expect(400);
    expect(refusedAt(searched.body)).toEqual({ error: 'VALIDATION_FAILED', paths: ['search'] });

    const signedUp = await t
      .http()
      .post('/api/auth/register')
      .send({ email: 'nul@example.test', password: 'A-good-passw0rd', displayName: NUL })
      .expect(400);
    expect(refusedAt(signedUp.body)).toEqual({
      error: 'VALIDATION_FAILED',
      paths: ['displayName'],
    });

    // Nothing of it was written.
    expect((await t.prisma.profile.findUniqueOrThrow({ where: { id: profile.id } })).name).toBe(
      profile.name,
    );
    // The only account is the one the test signed in with: the address stays free.
    expect(await t.prisma.user.count()).toBe(1);
  });
});
