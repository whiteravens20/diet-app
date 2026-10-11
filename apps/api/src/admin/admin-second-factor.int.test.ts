// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { SecondFactorSetup } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anAuthenticator, type Authenticator } from '../testing/authenticator.js';
import { resetDatabase } from '../testing/database.js';
import { asAdmin } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const WEB = 'http://localhost:3000';
const USER = 'admin';
const PASSWORD = 'integration-test-admin-password';

describe('the administrator\'s second factor', () => {
  let t: TestApp;
  let app: Authenticator;
  let clients = 0;

  beforeAll(async () => {
    // Each request of a test comes from an address of its own, so that what one client may try is not what limits a test.
    t = await createTestApp({ TRUST_PROXY: '1' });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    app = anAuthenticator(t);
  });

  const elsewhere = (): Record<string, string> => ({ Origin: WEB, 'X-Forwarded-For': `198.51.${Math.floor((clients += 1) / 250)}.${(clients % 250) + 1}` });
  const cookieOf = (res: { headers: Record<string, unknown> }): string => /admin_session=[^;]*/.exec(String(res.headers['set-cookie']))![0];
  const state = async (cookie?: string) => (await t.http().get('/api/admin/session').set(cookie ? { Cookie: cookie } : {}).expect(200)).body;
  const stats = (cookie: string) => t.http().get('/api/admin/stats').set('Cookie', cookie);
  const signIn = (body: object) => t.http().post('/api/admin/session').set(elsewhere()).send(body);
  const setUp = (password = PASSWORD, cookie = asAdmin.Cookie) => t.http().post('/api/admin/session/second-factor/setup').set(elsewhere()).set('Cookie', cookie).send({ password });
  const begin = (body: object, cookie = asAdmin.Cookie) => t.http().post('/api/admin/session/second-factor').set(elsewhere()).set('Cookie', cookie).send(body);
  const switchOff = (body: object, cookie: string) => t.http().delete('/api/admin/session/second-factor').set(elsewhere()).set('Cookie', cookie).send(body);
  const factor = () => t.prisma.secondFactor.findUniqueOrThrow({ where: { id: 'administrator' } });

  /** The administrator with a second factor: the secret of the app, and the session that set it up. */
  async function withSecondFactor(): Promise<{ secret: string; cookie: string }> {
    const setup: SecondFactorSetup = (await setUp().expect(200)).body;
    const res = await begin({ enrolment: setup.enrolment, code: app.code(setup.secret) }).expect(204);
    app.wait(30);
    return { secret: setup.secret, cookie: cookieOf(res) };
  }

  describe('is set up from the panel', () => {
    it('by the administrator, who is signed in and shows the password again', async () => {
      await t.http().post('/api/admin/session/second-factor/setup').set(elsewhere()).send({ password: PASSWORD }).expect(401);
      expect((await setUp('not-the-password').expect(401)).body.error).toBe('INVALID_PASSWORD');

      const setup: SecondFactorSetup = (await setUp().expect(200)).body;

      expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(decodeURIComponent(new URL(setup.uri).pathname)).toBe('/Diet App admin (localhost):admin');
      expect(await state()).toMatchObject({ secondFactor: false });
    });

    it('by the first code, which ends every admin session there was and gives this browser a new one', async () => {
      const setup: SecondFactorSetup = (await setUp().expect(200)).body;
      expect((await begin({ enrolment: setup.enrolment, code: app.wrongCode(setup.secret) }).expect(401)).body.error).toBe('INVALID_SECOND_FACTOR_CODE');

      const res = await begin({ enrolment: setup.enrolment, code: app.code(setup.secret) }).expect(204);

      expect((await stats(asAdmin.Cookie).expect(401)).body.error).toBe('INVALID_ADMIN_SESSION');
      await stats(cookieOf(res)).expect(200);
      expect(await state(cookieOf(res))).toEqual({ enabled: true, signedIn: true, secondFactor: true });
    });

    it('once, kept as an account\'s is, and with no recovery codes: the way back in is the operator\'s', async () => {
      const { cookie } = await withSecondFactor();

      expect((await setUp(PASSWORD, cookie).expect(409)).body.error).toBe('SECOND_FACTOR_ALREADY_ON');
      expect((await factor()).secretEncrypted).toMatch(/^v2:/);
      expect((await factor()).userId).toBeNull();
      expect(await t.prisma.recoveryCode.count()).toBe(0);
    });

    it('not with a secret that was handed to an account', async () => {
      const { aUser, as } = await import('../testing/factories.js');
      const user = await aUser(t);
      const theirs: SecondFactorSetup = (await t.http().post('/api/users/me/second-factor/setup').set(as(user)).send({ currentPassword: user.password }).expect(200)).body;

      expect((await begin({ enrolment: theirs.enrolment, code: app.code(theirs.secret) }).expect(400)).body.error).toBe('SECOND_FACTOR_SETUP_EXPIRED');
    });
  });

  describe('is asked at sign-in', () => {
    let secret: string;

    beforeEach(async () => {
      ({ secret } = await withSecondFactor());
    });

    it('with the user and the password: the three open the panel', async () => {
      const res = await signIn({ user: USER, password: PASSWORD, code: app.code(secret) }).expect(204);

      await stats(cookieOf(res)).expect(200);
    });

    it('and a missing or a wrong code is answered as a wrong password is', async () => {
      const wrongPassword = await signIn({ user: USER, password: 'not-the-password', code: app.code(secret) }).expect(401);
      const noCode = await signIn({ user: USER, password: PASSWORD }).expect(401);
      const wrongCode = await signIn({ user: USER, password: PASSWORD, code: app.wrongCode(secret) }).expect(401);
      const noDigits = await signIn({ user: USER, password: PASSWORD, code: 'ABCDE-FGHJK' }).expect(401);

      for (const refused of [noCode, wrongCode, noDigits]) {
        expect(refused.body).toEqual(wrongPassword.body);
        expect(refused.headers['set-cookie']).toBeUndefined();
      }
      expect(wrongPassword.body.error).toBe('INVALID_CREDENTIALS');
    });

    it('with a code that is good once', async () => {
      const code = app.code(secret);
      await signIn({ user: USER, password: PASSWORD, code }).expect(204);

      await signIn({ user: USER, password: PASSWORD, code }).expect(401);
    });

    it('and is looked at only for the right password: a stranger cannot run the count of wrong codes up', async () => {
      for (let n = 0; n < 7; n += 1) await signIn({ user: USER, password: 'not-the-password', code: app.wrongCode(secret) }).expect(401);

      expect((await factor()).failures).toBe(0);
      await signIn({ user: USER, password: PASSWORD, code: app.code(secret) }).expect(204);
    });

    it('five wrong codes for the right password, wherever they come from, and the next has to wait', async () => {
      for (let n = 0; n < 5; n += 1) await signIn({ user: USER, password: PASSWORD, code: app.wrongCode(secret) }).expect(401);

      const held = await signIn({ user: USER, password: PASSWORD, code: app.code(secret) }).expect(429);

      expect(held.body.error).toBe('TOO_MANY_ATTEMPTS');
      expect(held.headers['retry-after']).toBe('30');
      app.wait(31);
      await signIn({ user: USER, password: PASSWORD, code: app.code(secret) }).expect(204);
    });
  });

  describe('is switched off from the panel', () => {
    it('with the password and a code: the panel opens with the password alone again', async () => {
      const { secret, cookie } = await withSecondFactor();

      expect((await switchOff({ password: 'not-the-password', code: app.code(secret) }, cookie).expect(401)).body.error).toBe('INVALID_PASSWORD');
      expect((await switchOff({ password: PASSWORD, code: app.wrongCode(secret) }, cookie).expect(401)).body.error).toBe('INVALID_SECOND_FACTOR_CODE');
      await switchOff({ password: PASSWORD, code: app.code(secret) }, cookie).expect(204);

      expect(await state()).toMatchObject({ secondFactor: false });
      await signIn({ user: USER, password: PASSWORD }).expect(204);
    });

    it('not when there is none', async () => {
      expect((await switchOff({ password: PASSWORD, code: '123456' }, asAdmin.Cookie).expect(409)).body.error).toBe('SECOND_FACTOR_NOT_ON');
    });
  });
});
