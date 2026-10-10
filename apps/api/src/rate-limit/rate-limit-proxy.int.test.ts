// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/** One reverse proxy stands in front and is trusted: it writes the client's address into the header. */
describe('rate limits behind one trusted proxy', () => {
  let t: TestApp;
  let sequence = 0;

  beforeAll(async () => {
    t = await createTestApp({ TRUST_PROXY: '1' });
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  const register = (forwardedFor: string) =>
    t
      .http()
      .post('/api/auth/register')
      .set('X-Forwarded-For', forwardedFor)
      .send({ email: `visitor-${(sequence += 1)}-${Date.now().toString(36)}@example.test`, password: 'Integration-Passw0rd', displayName: 'Visitor' });
  const basic = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };

  describe('signing in', () => {
    const login = (from: string, email: string, password: string) =>
      t.http().post('/api/auth/login').set('X-Forwarded-For', from).send({ email, password });

    it('counts wrong passwords against the account and the address together, so that a stranger cannot keep the owner out', async () => {
      const owner = await aUser(t);
      for (let i = 0; i < 10; i += 1) expect((await login('203.0.113.101', owner.email, 'not-the-password')).status).toBe(401);

      // The address that guessed is held up for a quarter of an hour, right password or not.
      const held = await login('203.0.113.101', owner.email, owner.password);
      expect(held.status).toBe(429);
      expect(held.body.error).toBe('RATE_LIMITED');
      expect(Number(held.headers['retry-after'])).toBeGreaterThan(600);
      // The owner, at another address, signs in as if nothing had happened.
      expect((await login('203.0.113.102', owner.email, owner.password)).status).toBe(200);
    });

    it('takes every address of one IPv6 network for the one client it is', async () => {
      const owner = await aUser(t);
      for (let i = 0; i < 10; i += 1) await login(`2001:db8:1:2::${i + 1}`, owner.email, 'not-the-password');

      expect((await login('2001:db8:1:2:aaaa:bbbb:cccc:dddd', owner.email, owner.password)).status).toBe(429);
      expect((await login('2001:db8:1:3::1', owner.email, owner.password)).status).toBe(200);
    });

    it('lets one account be tried fifty times in a quarter of an hour from everywhere together', async () => {
      const owner = await aUser(t);
      for (let address = 1; address <= 5; address += 1) {
        for (let i = 0; i < 10; i += 1) expect((await login(`203.0.113.${110 + address}`, owner.email, 'not-the-password')).status).toBe(401);
      }

      // Five addresses used up what the account allows: a sixth is refused before its password is looked at.
      expect((await login('203.0.113.120', owner.email, owner.password)).status).toBe(429);
      // Nobody else's account is held up by it.
      const other = await aUser(t);
      expect((await login('203.0.113.120', other.email, other.password)).status).toBe(200);
    });
  });

  describe('a route that tries a credential', () => {
    const fresh = (): string => `nobody-${(sequence += 1)}-${Date.now().toString(36)}@example.test`;
    const statuses = async (count: number, send: (index: number) => Promise<{ status: number }>): Promise<number[]> => {
      const seen: number[] = [];
      for (let index = 0; index < count; index += 1) seen.push((await send(index)).status);
      return seen;
    };

    it('counts sign-ins against the address they come from as well, whatever the account', async () => {
      const user = await aUser(t);
      const login = (from: string, email: string, password: string) =>
        t.http().post('/api/auth/login').set('X-Forwarded-For', from).send({ email, password });

      // Thirty accounts in a quarter of an hour, one try each: no account ran out, the address did.
      expect(await statuses(30, () => login('203.0.113.130', fresh(), 'whatever-it-is'))).toEqual(Array(30).fill(401));
      expect((await login('203.0.113.130', user.email, user.password)).status).toBe(429);
      expect((await login('203.0.113.131', user.email, user.password)).status).toBe(200);
    });

    it('counts made-up tokens against the address they come from', async () => {
      const refresh = (from: string, refreshToken: string) =>
        t.http().post('/api/auth/refresh').set('X-Forwarded-For', from).send({ refreshToken });

      expect(await statuses(31, (index) => refresh('203.0.113.140', `made-up-${index}`))).toEqual([...Array(30).fill(401), 429]);
      expect((await refresh('203.0.113.141', 'made-up-0')).status).toBe(401);
    });

    it('lets one address ask for fifteen password resets in a quarter of an hour, whoever they are for', async () => {
      const ask = (from: string) => t.http().post('/api/auth/password-reset/request').set('X-Forwarded-For', from).send({ email: fresh() });

      expect(await statuses(16, () => ask('203.0.113.150'))).toEqual([...Array(15).fill(202), 429]);
      expect((await ask('203.0.113.151')).status).toBe(202);
    });

    it('lets one address try ten links from mails a minute', async () => {
      const verify = (from: string, token: string) => t.http().post('/api/auth/verify-email').set('X-Forwarded-For', from).send({ token });

      expect(await statuses(11, (index) => verify('203.0.113.160', `token-${index}`))).toEqual([...Array(10).fill(400), 429]);
      expect((await verify('203.0.113.161', 'token-0')).status).toBe(400);
    });
  });

  it('gives two clients an allowance each', async () => {
    const first: number[] = [];
    for (let i = 0; i < 11; i += 1) first.push((await register('203.0.113.7')).status);

    expect(first).toEqual([...Array(10).fill(201), 429]);
    expect((await register('203.0.113.8')).status).toBe(201);
  });

  it('counts the health probe for each client on its own', async () => {
    const remaining = async (from: string): Promise<number> =>
      Number((await t.http().get('/api/health').set('X-Forwarded-For', from).expect(200)).headers['x-ratelimit-remaining']);

    const first = await remaining('203.0.113.170');
    expect(first).toBeGreaterThan(0);
    expect(await remaining('203.0.113.170')).toBe(first - 1);
    // Somebody flooding the route from one address does not use up a probe's allowance at another.
    expect(await remaining('203.0.113.171')).toBe(first);
  });

  it('believes the address the proxy wrote, not one a client wrote in front of it', async () => {
    // The proxy appends what it saw; whatever stood there before is the client's own claim.
    const res = await register('198.51.100.99, 203.0.113.7');

    // Counted as 203.0.113.7, whose allowance the first test used up.
    expect(res.status).toBe(429);
  });

  it('shows the administrator the client it took the request for', async () => {
    const res = await t.http().get('/api/admin/connection').set(basic).set('X-Forwarded-For', '198.51.100.99, 203.0.113.21').expect(200);

    expect(res.body).toMatchObject({
      clientAddress: '203.0.113.21',
      forwardedFor: '198.51.100.99, 203.0.113.21',
      forwardedHops: 2,
      trustProxy: 1,
      countedAsProxy: false,
      overTrusted: false,
    });
    expect(res.body.peerAddress).not.toBe('203.0.113.21');
  });

  it('tells the administrator when the setting counts a proxy the request did not pass', async () => {
    // No proxy wrote the header: whoever reaches the API this way could write it themselves.
    const res = await t.http().get('/api/admin/connection').set(basic).expect(200);

    expect(res.body).toMatchObject({ forwardedFor: null, forwardedHops: 0, trustProxy: 1, overTrusted: true });
  });

  it('counts a wrong administrator password against the client, not against the proxy', async () => {
    const wrong = { Authorization: `Basic ${Buffer.from('admin:not-the-password').toString('base64')}` };
    for (let i = 0; i < 5; i += 1) {
      await t.http().get('/api/admin/stats').set(wrong).set('X-Forwarded-For', '203.0.113.50').expect(401);
    }

    // The guesser waits; the administrator, at another address, does not.
    await t.http().get('/api/admin/stats').set(basic).set('X-Forwarded-For', '203.0.113.50').expect(429);
    await t.http().get('/api/admin/stats').set(basic).set('X-Forwarded-For', '203.0.113.60').expect(200);
  });
});
