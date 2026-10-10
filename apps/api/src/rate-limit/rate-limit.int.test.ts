// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { SignInGate } from './sign-in-gate.js';

/**
 * No proxy is trusted here (`TRUST_PROXY` is not set), and every request comes
 * from the same address: the situation of an instance behind its web server,
 * where the API cannot tell its visitors apart.
 */
describe('rate limits behind a proxy that is not trusted', () => {
  let t: TestApp;
  let sequence = 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  /** An address nobody has registered, unique to the call. */
  const fresh = (): string => `nobody-${(sequence += 1)}-${Date.now().toString(36)}@example.test`;
  const login = (email: string, password: string) => t.http().post('/api/auth/login').send({ email, password });
  const statuses = async (count: number, send: (index: number) => Promise<{ status: number }>): Promise<number[]> => {
    const seen: number[] = [];
    for (let index = 0; index < count; index += 1) seen.push((await send(index)).status);
    return seen;
  };

  describe('signing in', () => {
    it('stops after ten wrong passwords for one account, for that account and for no other', async () => {
      const [victim, bystander] = [await aUser(t), await aUser(t)];

      expect(await statuses(10, () => login(victim.email, 'not-the-password'))).toEqual(Array(10).fill(401));

      // The account that was guessed at is closed for the rest of the minute, even to its owner.
      const eleventh = await login(victim.email, victim.password);
      expect(eleventh.status).toBe(429);
      expect(eleventh.body.error).toBe('RATE_LIMITED');
      expect(eleventh.headers['retry-after']).toBeDefined();
      // Everybody else signs in as if nothing had happened.
      expect((await login(bystander.email, bystander.password)).status).toBe(200);
    });

    it('takes every way of writing an address for the one account it is', async () => {
      const user = await aUser(t);
      const spellings = [user.email, user.email.toUpperCase(), `  ${user.email}`];

      await statuses(10, (index) => login(spellings[index % 3]!, 'not-the-password'));

      expect((await login(user.email.toUpperCase(), user.password)).status).toBe(429);
    });

    it('is not held up by any number of attempts on accounts that do not exist', async () => {
      const user = await aUser(t);

      expect(await statuses(25, () => login(fresh(), 'whatever-it-is'))).toEqual(Array(25).fill(401));

      expect((await login(user.email, user.password)).status).toBe(200);
    });
  });

  describe('the token routes', () => {
    it('count a refresh against the token that is presented, so that nonsense locks out nobody', async () => {
      const user = await aUser(t);
      const refresh = (refreshToken: string) => t.http().post('/api/auth/refresh').send({ refreshToken });

      // One made-up token over and over: it runs out. Many made-up tokens: each is refused on its own.
      expect(await statuses(12, () => refresh('made-up'))).toEqual([...Array(10).fill(401), 429, 429]);
      expect(await statuses(15, (index) => refresh(`made-up-${index}`))).toEqual(Array(15).fill(401));

      const real = await refresh(user.refreshToken);
      expect(real.status).toBe(200);
      expect(real.body.tokens.accessToken).toBeTruthy();
    });

    it('count a link from a mail against its token', async () => {
      const verify = (token: string) => t.http().post('/api/auth/verify-email').send({ token });

      expect(await statuses(11, () => verify('one-token'))).toEqual([...Array(10).fill(400), 429]);
      expect((await verify('another-token')).status).toBe(400);
    });
  });

  it('a password reset is asked for at most five times in a quarter of an hour for one address', async () => {
    const ask = (email: string) => t.http().post('/api/auth/password-reset/request').send({ email });
    const address = fresh();

    expect(await statuses(6, () => ask(address))).toEqual([202, 202, 202, 202, 202, 429]);
    expect((await ask(fresh())).status).toBe(202);
  });

  describe('a signed-in user', () => {
    const changePassword = (user: TestUser) =>
      t.http().post('/api/users/me/password').set(as(user)).send({ currentPassword: 'not-the-password', newPassword: 'Another-Passw0rd' });

    it('gets five tries a minute at their current password, and uses up nobody else\'s', async () => {
      const [guesser, other] = [await aUser(t), await aUser(t)];

      expect(await statuses(6, () => changePassword(guesser))).toEqual([401, 401, 401, 401, 401, 429]);

      // Same address, another user: their own count.
      expect((await changePassword(other)).status).toBe(401);
      // And the guesser's other password routes each have their own five.
      const deletion = await t.http().delete('/api/users/me').set(as(guesser)).send({ currentPassword: 'not-the-password' });
      expect(deletion.status).toBe(401);
    });

    it('is counted on their own on every route, not with everybody at the same address', async () => {
      const [first, second] = [await aUser(t), await aUser(t)];
      const remaining = async (user: TestUser): Promise<number> =>
        Number((await t.http().get('/api/users/me').set(as(user)).expect(200)).headers['x-ratelimit-remaining']);

      const before = await remaining(first);
      await remaining(first);
      await remaining(first);

      expect(await remaining(first)).toBe(before - 3);
      expect(await remaining(second)).toBe(before);
    });

    it('is not what a token that does not verify makes of its sender', async () => {
      const probe = async (token: string): Promise<number> =>
        Number((await t.http().get('/api/users/me').set({ Authorization: `Bearer ${token}` }).expect(401)).headers['x-ratelimit-remaining']);

      // Two different made-up tokens share the allowance of the address they come from.
      const first = await probe('made.up.token');
      expect(await probe('another.made.up')).toBe(first - 1);
    });
  });

  describe('what is counted against the address', () => {
    it('is one allowance for everybody, whatever address a visitor claims in a header', async () => {
      const register = (index: number) =>
        t
          .http()
          .post('/api/auth/register')
          .set('X-Forwarded-For', `198.51.100.${index + 1}`)
          .send({ email: fresh(), password: 'Integration-Passw0rd', displayName: 'Visitor' });

      // Ten sign-ups a minute, and a different claimed address each time buys no more.
      expect(await statuses(11, register)).toEqual([...Array(10).fill(201), 429]);
    });

    it('does not include the health probe or the public configuration', async () => {
      for (const path of ['/api/health', '/api/config']) {
        const res = await t.http().get(path).expect(200);
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      }
    });
  });

  describe('the administrator\'s password', () => {
    const basic = (password: string) => ({ Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` });
    const stats = (password: string) => t.http().get('/api/admin/stats').set(basic(password));

    it('makes a client wait after five wrong tries, right password or not, and lets it in once the wait is over', async () => {
      const gate = t.app.get(SignInGate);
      let time = Date.now();
      gate.now = () => time;

      expect(await statuses(5, () => stats('not-the-password'))).toEqual(Array(5).fill(401));

      const held = await stats('integration-test-admin-password');
      expect(held.status).toBe(429);
      expect(held.body.error).toBe('TOO_MANY_ATTEMPTS');
      expect(held.headers['retry-after']).toBe('30');

      time += 31_000;
      expect((await stats('integration-test-admin-password')).status).toBe(200);
      // A correct sign-in clears the count: four more wrong ones cost nothing.
      expect(await statuses(4, () => stats('not-the-password'))).toEqual(Array(4).fill(401));
      expect((await stats('integration-test-admin-password')).status).toBe(200);
    });

    it('does not count a request that presents no password at all', async () => {
      expect(await statuses(8, () => t.http().get('/api/admin/stats'))).toEqual(Array(8).fill(401));

      expect((await stats('integration-test-admin-password')).status).toBe(200);
    });
  });

  describe('the reviewers\' password', () => {
    it('counts wrong tries at the same gate', async () => {
      const basic = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };
      await t.http().patch('/api/admin/instance-settings').set(basic).send({ reviewerEnabled: true, reviewerPassword: 'Reviewers-Passw0rd' }).expect(200);
      const gate = t.app.get(SignInGate);
      const signIn = (password: string) => t.http().post('/api/review/auth').send({ password, label: 'pl reviewer' });

      const counted = vi.spyOn(gate, 'failed');

      expect((await signIn('Reviewers-Passw0rd')).status).toBe(204);
      expect(await statuses(4, () => signIn('not-the-password'))).toEqual(Array(4).fill(401));

      // Four wrong ones in a row were counted at the reviewers' door, for this client.
      expect(counted.mock.calls.map(([door]) => door)).toEqual(Array(4).fill('reviewer'));
      const client = counted.mock.calls[0]![1];
      expect(() => gate.assertOpen('reviewer', client)).not.toThrow();
      // One more closes the gate for it.
      gate.failed('reviewer', client);
      expect(() => gate.assertOpen('reviewer', client)).toThrow();
      counted.mockRestore();
    });
  });
});
