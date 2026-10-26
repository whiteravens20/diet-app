// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, as } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe("an account's language", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('is the one the account signs up in, and counts as chosen', async () => {
    const signedUp = await t
      .http()
      .post('/api/auth/register')
      .set('accept-language', 'pl')
      .send({
        email: `language-${Date.now().toString(36)}@example.test`,
        password: 'Language-Passw0rd',
        displayName: 'Language',
      });
    expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(201);

    const me = await t
      .http()
      .get('/api/users/me')
      .set({ Authorization: `Bearer ${signedUp.body.tokens.accessToken}` });

    expect(me.body).toMatchObject({ locale: 'pl', localeChosen: true });
  });

  it('of an account made before it was kept is not chosen until one is saved, whatever else is', async () => {
    const user = await aUser(t);
    // As the accounts made before the language was kept stand.
    await t.prisma.user.update({
      where: { id: user.id },
      data: { locale: 'en', localeChosen: false },
    });

    const before = await t.http().get('/api/users/me').set(as(user));
    expect(before.body).toMatchObject({ locale: 'en', localeChosen: false });

    const themed = await t.http().patch('/api/users/me').set(as(user)).send({ theme: 'dark' });
    expect(themed.body).toMatchObject({ theme: 'dark', localeChosen: false });

    const saved = await t.http().patch('/api/users/me').set(as(user)).send({ locale: 'pl' });
    expect(saved.body).toMatchObject({ locale: 'pl', localeChosen: true });
  });
});
