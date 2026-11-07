// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe("the time zone of an account's device", () => {
  let t: TestApp;
  let user: TestUser;

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

  it('is none until a client sends it, then kept as sent, and refused where it is no time zone', async () => {
    expect(
      (await t.http().get('/api/users/me').set(as(user)).expect(200)).body.timeZone,
    ).toBeNull();
    const sent = await t
      .http()
      .patch('/api/users/me')
      .set(as(user))
      .send({ timeZone: 'Europe/Warsaw' })
      .expect(200);
    expect(sent.body.timeZone).toBe('Europe/Warsaw');
    expect((await t.http().get('/api/users/me').set(as(user)).expect(200)).body.timeZone).toBe(
      'Europe/Warsaw',
    );
    await t
      .http()
      .patch('/api/users/me')
      .set(as(user))
      .send({ timeZone: 'Mars/Olympus' })
      .expect(400);
  });
});
