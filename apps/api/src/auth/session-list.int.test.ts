// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { AccountSession, AuthResponse } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { SessionsService } from './sessions.service.js';

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

describe('the sessions of an account, as the account sees them', () => {
  let t: TestApp;
  let sessions: SessionsService;
  let user: TestUser;
  let laptop: AuthResponse;
  let phone: AuthResponse;

  beforeAll(async () => {
    t = await createTestApp();
    sessions = t.app.get(SessionsService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    user = await aUser(t);
    laptop = await signIn(FIREFOX);
    phone = await signIn(PHONE);
  });

  const signIn = async (userAgent: string, who = user): Promise<AuthResponse> =>
    (await t.http().post('/api/auth/login').set('User-Agent', userAgent).send({ email: who.email, password: who.password }).expect(200)).body;
  const listed = async (who = user): Promise<AccountSession[]> => (await t.http().get('/api/users/me/sessions').set(as(who)).expect(200)).body;
  const works = async (token: string): Promise<boolean> =>
    sessions.refresh(token).then(
      () => true,
      () => false,
    );

  it('are listed with what each was opened from, the one used last first', async () => {
    const list = await listed();

    expect(list.map((session) => [session.id, session.label])).toEqual([
      [phone.sessionId, 'Safari · iOS'],
      [laptop.sessionId, 'Firefox · Linux'],
      // The one the account was made with, by a client that did not say what it is.
      [expect.any(String), null],
    ]);
    for (const session of list) {
      expect(new Date(session.endsAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
      expect(session.startedAt).toBe(session.lastUsedAt);
    }
  });

  it('say when each was last used, and still when it began', async () => {
    const before = (await listed()).find((session) => session.id === laptop.sessionId)!;

    await sessions.refresh(laptop.tokens.refreshToken);

    const [first] = await listed();
    expect(first!.id).toBe(laptop.sessionId);
    expect(first!.startedAt).toBe(before.startedAt);
    expect(new Date(first!.lastUsedAt).getTime()).toBeGreaterThan(new Date(before.lastUsedAt).getTime());
  });

  it('are the account\'s own', async () => {
    const other = await aUser(t);

    expect(await listed(other)).toHaveLength(1);
    expect((await listed()).map((session) => session.id)).not.toContain((await listed(other))[0]!.id);
  });

  it('can be ended one at a time: that one stops, the others go on, and it leaves the list', async () => {
    await t.http().delete(`/api/users/me/sessions/${phone.sessionId}`).set(as(user)).expect(204);

    expect(await works(phone.tokens.refreshToken)).toBe(false);
    expect(await works(laptop.tokens.refreshToken)).toBe(true);
    expect((await listed()).map((session) => session.id)).not.toContain(phone.sessionId);
  });

  it('cannot be ended by another account, nor twice', async () => {
    const other = await aUser(t);

    expect((await t.http().delete(`/api/users/me/sessions/${phone.sessionId}`).set(as(other)).expect(404)).body.error).toBe('SESSION_NOT_FOUND');
    expect(await works(phone.tokens.refreshToken)).toBe(true);

    await t.http().delete(`/api/users/me/sessions/${laptop.sessionId}`).set(as(user)).expect(204);
    await t.http().delete(`/api/users/me/sessions/${laptop.sessionId}`).set(as(user)).expect(404);
    // What is no id names no session: refused as it comes in.
    await t.http().delete('/api/users/me/sessions/not-an-id').set(as(user)).expect(400);
  });

  it('can be ended all at once', async () => {
    await t.http().delete('/api/users/me/sessions').set(as(user)).expect(204);

    // The session that asked is ended with the others: its access token opens nothing any more.
    await t.http().get('/api/users/me/sessions').set(as(user)).expect(401);
    expect(await sessions.list(user.id)).toEqual([]);
    expect(await works(laptop.tokens.refreshToken)).toBe(false);
    expect(await works(phone.tokens.refreshToken)).toBe(false);
    expect(await works(user.refreshToken)).toBe(false);
  });

  it('are not listed once they have run out', async () => {
    await t.prisma.refreshToken.updateMany({ where: { familyId: phone.sessionId }, data: { familyExpiresAt: new Date(Date.now() - 1000) } });
    await t.prisma.refreshToken.updateMany({ where: { familyId: laptop.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await listed()).toHaveLength(1);
  });

  it('are named when an account is made, too', async () => {
    const made = (await t.http().post('/api/auth/register').set('User-Agent', FIREFOX).send({ email: 'named@example.test', password: 'Brand-New-Passw0rd', displayName: 'Named' }).expect(201)).body as AuthResponse;

    const list = (await t.http().get('/api/users/me/sessions').set({ Authorization: `Bearer ${made.tokens.accessToken}` }).expect(200)).body as AccountSession[];
    expect(list).toMatchObject([{ id: made.sessionId, label: 'Firefox · Linux' }]);
  });
});
