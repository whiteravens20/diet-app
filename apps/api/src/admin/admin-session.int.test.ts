// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveReviewerSecret, signReviewerCookie } from '../review/session.js';
import { JwtService } from '@nestjs/jwt';
import { resetDatabase } from '../testing/database.js';
import { aUser, asAdmin } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { signAdminSession } from './admin-session.js';

const WEB = 'http://localhost:3000';
const CREDENTIALS = { user: 'admin', password: 'integration-test-admin-password' };

describe('the administrator\'s way in', () => {
  let t: TestApp;
  let config: ConfigService;

  beforeAll(async () => {
    t = await createTestApp();
    config = t.app.get(ConfigService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });

  const stats = (cookie?: string) => (cookie ? t.http().get('/api/admin/stats').set('Cookie', cookie) : t.http().get('/api/admin/stats'));
  const cookieOf = (res: { headers: Record<string, unknown> }): string => /admin_session=[^;]*/.exec(String(res.headers['set-cookie']))![0];
  /** A session signed with other settings than the instance's: `over` replaces what the instance has. */
  const signedWith = (over: Record<string, string>, epoch = 0, lifetime?: number): string =>
    `admin_session=${signAdminSession({ get: (key: string) => over[key] ?? config.get(key) } as never, epoch, lifetime)}`;

  describe('signing in', () => {
    const signIn = (body: object = CREDENTIALS, headers: Record<string, string> = { Origin: WEB }) => t.http().post('/api/admin/session').set(headers).send(body);

    it('gives the instance\'s user and password once, for a session in a cookie no script reads', async () => {
      const res = await signIn().expect(204);
      const attributes = String(res.headers['set-cookie']).split('; ');

      expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/api/admin', `Max-Age=${8 * 3600}`]));
      expect(String(res.headers['set-cookie'])).not.toContain(CREDENTIALS.password);
      await stats(cookieOf(res)).expect(200);
    });

    it.each([
      ['a wrong password', { user: 'admin', password: 'not-the-password' }],
      ['a wrong user', { user: 'root', password: CREDENTIALS.password }],
    ])('is refused with %s, and says the same either way', async (_name, body) => {
      const refused = await signIn(body).expect(401);

      expect(refused.body).toMatchObject({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' });
      expect(refused.headers['set-cookie']).toBeUndefined();
    });

    it.each([
      ['from another site', { Origin: 'https://elsewhere.example' }],
      ['that does not say where it comes from', {}],
    ])('is refused for a request %s, right password or not', async (_name, headers) => {
      expect((await signIn(CREDENTIALS, headers).expect(403)).body.error).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('takes nothing but its own fields', async () => {
      await signIn({ ...CREDENTIALS, remember: true }).expect(400);
      await signIn({ user: 'admin' }).expect(400);
    });
  });

  describe('a request to the admin routes', () => {
    it('is refused without a session, and HTTP Basic opens nothing any more', async () => {
      expect((await stats().expect(401)).body.error).toBe('AUTH_REQUIRED');

      const basic = { Authorization: `Basic ${Buffer.from(`${CREDENTIALS.user}:${CREDENTIALS.password}`).toString('base64')}` };
      const refused = await t.http().get('/api/admin/stats').set(basic).expect(401);
      expect(refused.headers['www-authenticate']).toBeUndefined();
    });

    it.each([
      ['signed with another key', () => signedWith({ DATA_ENCRYPTION_SECRET: 'c3'.repeat(32) })],
      ['begun with a password the instance no longer has', () => signedWith({ ADMIN_PASSWORD: 'the-password-of-before' })],
      ['begun under another user name', () => signedWith({ ADMIN_USER: 'root' })],
      ['of an epoch that is over', () => signedWith({}, -1)],
      ['that has run out', () => signedWith({}, 0, -10)],
      ['that is a reviewer\'s', () => `admin_session=${signReviewerCookie(t.app.get(JwtService, { strict: false }), resolveReviewerSecret(config), { label: 'x', epoch: 0 }).token}`],
      ['that is no session at all', () => 'admin_session=not-a-token'],
    ])('is refused with a session %s', async (_name, cookie) => {
      expect((await stats(cookie()).expect(401)).body.error).toBe('INVALID_ADMIN_SESSION');
    });

    it('is not opened by the access token of an account', async () => {
      const user = await aUser(t);

      await t.http().get('/api/admin/stats').set({ Authorization: `Bearer ${user.accessToken}` }).expect(401);
      await stats(`admin_session=${user.accessToken}`).expect(401);
    });

    it.each([
      ['from another site', { Origin: 'https://elsewhere.example' }],
      ['that does not say where it comes from', {}],
    ])('that changes something is refused %s, session or not', async (_name, headers) => {
      const refused = await t.http().patch('/api/admin/instance-settings').set('Cookie', asAdmin.Cookie).set(headers).send({ reviewerEnabled: true });

      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('ORIGIN_NOT_ALLOWED');
      expect((await t.http().get('/api/admin/instance-settings').set(asAdmin).expect(200)).body.reviewerEnabled).toBe(false);
    });

    it('that only reads needs the session alone', async () => {
      await stats(asAdmin.Cookie).expect(200);
    });
  });

  describe('the session', () => {
    const state = (cookie?: string) => (cookie ? t.http().get('/api/admin/session').set('Cookie', cookie) : t.http().get('/api/admin/session'));

    it('is told to the admin pages: whether there is a panel, and whether this browser is in', async () => {
      expect((await state().expect(200)).body).toEqual({ enabled: true, signedIn: false, secondFactor: false });
      expect((await state(asAdmin.Cookie).expect(200)).body).toEqual({ enabled: true, signedIn: true, secondFactor: false });
      expect((await state(signedWith({ ADMIN_PASSWORD: 'the-password-of-before' })).expect(200)).body).toEqual({ enabled: true, signedIn: false, secondFactor: false });
    });

    it('is signed out of by taking the cookie away', async () => {
      const res = await t.http().delete('/api/admin/session').set(asAdmin).expect(204);

      expect(String(res.headers['set-cookie'])).toContain('admin_session=;');
      expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    });

    it('can be ended everywhere at once: every session there is stops, and a new sign-in works', async () => {
      const other = cookieOf(await t.http().post('/api/admin/session').set({ Origin: WEB }).send(CREDENTIALS).expect(204));

      await t.http().post('/api/admin/session/end-all').set(asAdmin).expect(204);

      expect((await stats(asAdmin.Cookie).expect(401)).body.error).toBe('INVALID_ADMIN_SESSION');
      await stats(other).expect(401);
      await stats(cookieOf(await t.http().post('/api/admin/session').set({ Origin: WEB }).send(CREDENTIALS).expect(204))).expect(200);
    });

    it('is not ended everywhere by somebody who is not in', async () => {
      await t.http().post('/api/admin/session/end-all').set({ Origin: WEB }).expect(401);

      await stats(asAdmin.Cookie).expect(200);
    });
  });
});
