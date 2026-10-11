// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import type { AuthResponse, SecondFactorChallenge, SecondFactorSetup, SecondFactorState } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aSecondFactor, anAuthenticator, type Authenticator } from '../testing/authenticator.js';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, asAdmin, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AccountSecondFactor } from './account-second-factor.service.js';
import { AuthService } from './auth.service.js';
import { SessionsService } from './sessions.service.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('the second step of signing in', () => {
  let t: TestApp;
  let auth: AuthService;
  let sessions: SessionsService;
  let app: Authenticator;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    auth = t.app.get(AuthService);
    sessions = t.app.get(SessionsService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    app = anAuthenticator(t);
    user = await aUser(t);
  });

  const state = async (who = user): Promise<SecondFactorState> => (await t.http().get('/api/users/me/second-factor').set(as(who)).expect(200)).body;
  const setUp = (password = user.password, who = user) => t.http().post('/api/users/me/second-factor/setup').set(as(who)).send({ currentPassword: password });
  const begin = (body: { enrolment: string; code: string }, who = user) => t.http().post('/api/users/me/second-factor').set(as(who)).send(body);
  const password = (who = user) => t.http().post('/api/auth/login').send({ email: who.email, password: who.password });
  const code = (body: { challenge: string; code: string }) => t.http().post('/api/auth/login/second-factor').send(body);
  /** The challenge an account gets for its password, without a request: a test may ask for many. */
  const challenged = async (who = user): Promise<string> => ((await auth.login({ email: who.email, password: who.password })) as SecondFactorChallenge).secondFactor.challenge;
  const factorOf = (who = user) => t.prisma.secondFactor.findUniqueOrThrow({ where: { userId: who.id } });

  describe('is set up', () => {
    it('by the holder of the account, who shows the password again', async () => {
      expect((await setUp('not-the-password').expect(401)).body.error).toBe('INVALID_PASSWORD');

      const setup: SecondFactorSetup = (await setUp().expect(200)).body;

      expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.expiresIn).toBe(900);
      const uri = new URL(setup.uri);
      expect(decodeURIComponent(uri.pathname)).toBe(`/Diet App (localhost):${user.email}`);
      expect(uri.searchParams.get('secret')).toBe(setup.secret);
      expect(uri.searchParams.get('issuer')).toBe('Diet App (localhost)');
    });

    it('with nothing kept and nothing changed until the first code has come back', async () => {
      await setUp().expect(200);

      expect(await t.prisma.secondFactor.count()).toBe(0);
      expect(await state()).toEqual({ enabled: false, since: null, recoveryCodesLeft: 0 });
      expect((await password().expect(200)).body.tokens).toBeDefined();
    });

    it('by the first code from the app, which is answered with ten recovery codes', async () => {
      const setup: SecondFactorSetup = (await setUp().expect(200)).body;

      const { recoveryCodes } = (await begin({ enrolment: setup.enrolment, code: app.code(setup.secret) }).expect(201)).body;

      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
      for (const recoveryCode of recoveryCodes) expect(recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(await state()).toEqual({ enabled: true, since: expect.any(String), recoveryCodesLeft: 10 });
    });

    it('with the secret and the recovery codes kept so that the database does not give them away', async () => {
      const setup: SecondFactorSetup = (await setUp().expect(200)).body;
      const { recoveryCodes } = (await begin({ enrolment: setup.enrolment, code: app.code(setup.secret) }).expect(201)).body;

      const factor = await t.prisma.secondFactor.findUniqueOrThrow({ where: { userId: user.id }, include: { recoveryCodes: true } });

      expect(factor.secretEncrypted).toMatch(/^v2:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
      const kept = JSON.stringify(factor);
      expect(kept).not.toContain(setup.secret);
      for (const recoveryCode of recoveryCodes as string[]) {
        expect(kept).not.toContain(recoveryCode);
        expect(kept).not.toContain(recoveryCode.replace('-', ''));
      }
      expect(factor.recoveryCodes.map((row) => row.codeHash)).toEqual(Array.from({ length: 10 }, () => expect.stringMatching(/^[0-9a-f]{64}$/)));
    });

    it('not by a wrong code', async () => {
      const setup: SecondFactorSetup = (await setUp().expect(200)).body;

      const refused = await begin({ enrolment: setup.enrolment, code: app.wrongCode(setup.secret) }).expect(401);

      expect(refused.body.error).toBe('INVALID_SECOND_FACTOR_CODE');
      expect((await state()).enabled).toBe(false);
    });

    it('not with a secret that was handed to another account, that waited too long, or that was not handed out here', async () => {
      const other = await aUser(t);
      const theirs: SecondFactorSetup = (await setUp(other.password, other).expect(200)).body;
      const own: SecondFactorSetup = (await setUp().expect(200)).body;

      expect((await begin({ enrolment: theirs.enrolment, code: app.code(theirs.secret) }).expect(400)).body.error).toBe('SECOND_FACTOR_SETUP_EXPIRED');
      expect((await begin({ enrolment: 'v2:00:00:00', code: app.code(own.secret) }).expect(400)).body.error).toBe('SECOND_FACTOR_SETUP_EXPIRED');
      app.wait(15 * 60 + 1);
      expect((await begin({ enrolment: own.enrolment, code: app.code(own.secret) }).expect(400)).body.error).toBe('SECOND_FACTOR_SETUP_EXPIRED');
      expect((await state()).enabled).toBe(false);
    });

    it('once: an account that has one switches it off before it sets up another', async () => {
      const setup: SecondFactorSetup = (await setUp().expect(200)).body;
      await begin({ enrolment: setup.enrolment, code: app.code(setup.secret) }).expect(201);
      app.wait(30);

      expect((await begin({ enrolment: setup.enrolment, code: app.code(setup.secret) }).expect(409)).body.error).toBe('SECOND_FACTOR_ALREADY_ON');
      expect((await setUp().expect(409)).body.error).toBe('SECOND_FACTOR_ALREADY_ON');
    });

    it('and ends every other session of the account, which began with the password alone', async () => {
      const elsewhere = await sessions.open({ id: user.id, displayName: 'User', role: 'user', emailVerified: true }, user.email, 'Safari · iOS');

      await aSecondFactor(t, user, app);

      await t.http().get('/api/users/me').set('Authorization', `Bearer ${elsewhere.tokens.accessToken}`).expect(401);
      await expect(sessions.refresh(elsewhere.tokens.refreshToken)).rejects.toMatchObject({ response: { error: 'INVALID_REFRESH' } });
      // The session that set it up has shown a code, and goes on.
      await t.http().get('/api/users/me').set(as(user)).expect(200);
      expect((await sessions.refresh(user.refreshToken)).sessionId).toBeDefined();
      expect((await t.http().get('/api/users/me/sessions').set(as(user)).expect(200)).body).toHaveLength(1);
    });
  });

  describe('is asked of an account that has it', () => {
    let secret: string;
    let recoveryCodes: string[];

    beforeEach(async () => {
      ({ secret, recoveryCodes } = await aSecondFactor(t, user, app));
    });

    it('after the password, which is answered with a challenge and no session', async () => {
      const res = await password().set('X-Session-Transport', 'cookie').expect(200);

      expect(res.body).toEqual({ secondFactor: { challenge: expect.stringMatching(/^[0-9a-f]{64}$/), expiresIn: 300 } });
      expect(res.headers['set-cookie']).toBeUndefined();
      // What is kept of the challenge is its hash.
      expect((await t.prisma.signInChallenge.findFirstOrThrow()).tokenHash).toBe(sha256(res.body.secondFactor.challenge));
    });

    it('and a code from the app then opens the session', async () => {
      const { challenge } = (await password().expect(200)).body.secondFactor;

      const session: AuthResponse = (await code({ challenge, code: app.code(secret) }).expect(200)).body;

      expect(session.user.id).toBe(user.id);
      await t.http().get('/api/users/me').set('Authorization', `Bearer ${session.tokens.accessToken}`).expect(200);
      expect((await sessions.refresh(session.tokens.refreshToken!)).sessionId).toBe(session.sessionId);
      const tokens = await t.prisma.refreshToken.findMany({ where: { familyId: session.sessionId } });
      expect(tokens.map((token) => token.secondFactorAt)).toEqual([expect.any(Date), expect.any(Date)]);
    });

    it('for a browser as for any client: the session comes in cookies when it asks for that', async () => {
      const { challenge } = (await password().expect(200)).body.secondFactor;

      const res = await code({ challenge, code: app.code(secret) }).set('X-Session-Transport', 'cookie').expect(200);

      expect(res.body.tokens.refreshToken).toBeUndefined();
      expect(String(res.headers['set-cookie'])).toMatch(/diet_refresh=[0-9a-f]+;.*HttpOnly/);
    });

    it('however the code is typed', async () => {
      const shown = app.code(secret);

      await code({ challenge: await challenged(), code: ` ${shown.slice(0, 3)} ${shown.slice(3)} ` }).expect(200);
    });

    it('and a wrong code opens nothing, while the challenge is good for another try', async () => {
      const challenge = await challenged();

      const refused = await code({ challenge, code: app.wrongCode(secret) }).expect(401);

      expect(refused.body.error).toBe('INVALID_SECOND_FACTOR_CODE');
      expect(refused.body.tokens).toBeUndefined();
      await code({ challenge, code: app.code(secret) }).expect(200);
    });

    it('with a code that is good once: not a second time, and none from before it', async () => {
      const earlier = app.code(secret);
      app.wait(30);
      const used = app.code(secret);
      await code({ challenge: await challenged(), code: used }).expect(200);

      expect((await code({ challenge: await challenged(), code: used }).expect(401)).body.error).toBe('INVALID_SECOND_FACTOR_CODE');
      expect((await code({ challenge: await challenged(), code: earlier }).expect(401)).body.error).toBe('INVALID_SECOND_FACTOR_CODE');
    });

    it('with a challenge that is good for one sign-in', async () => {
      const challenge = await challenged();
      await code({ challenge, code: app.code(secret) }).expect(200);
      app.wait(30);

      expect((await code({ challenge, code: app.code(secret) }).expect(401)).body.error).toBe('INVALID_SIGN_IN_CHALLENGE');
    });

    it('with a challenge that two requests cannot both use', async () => {
      const challenge = await challenged();
      const first = app.code(secret);
      app.wait(30);
      const second = app.code(secret);

      // Both codes are right at this moment: the one of this half minute and the one before.
      const answers = await Promise.all([code({ challenge, code: first }), code({ challenge, code: second })]);

      expect(answers.map((res) => res.status).sort()).toEqual([200, 401]);
      // The session that set the factor up, and the one that was opened now.
      expect(await sessions.list(user.id)).toHaveLength(2);
    });

    it('with a challenge that does not wait long, and none that was never given', async () => {
      const challenge = await challenged();
      await t.prisma.signInChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      expect((await code({ challenge, code: app.code(secret) }).expect(401)).body.error).toBe('INVALID_SIGN_IN_CHALLENGE');
      expect((await code({ challenge: 'ab'.repeat(32), code: app.code(secret) }).expect(401)).body.error).toBe('INVALID_SIGN_IN_CHALLENGE');
    });

    it('only of whoever knows the password: a wrong one is answered as for any account', async () => {
      const refused = await t.http().post('/api/auth/login').send({ email: user.email, password: 'not-the-password' }).expect(401);

      expect(refused.body.error).toBe('INVALID_CREDENTIALS');
      expect(await t.prisma.signInChallenge.count()).toBe(0);
    });

    it('and a recovery code stands in for the app, once, however it is typed', async () => {
      const [first, second] = recoveryCodes as [string, string];

      await code({ challenge: await challenged(), code: first }).expect(200);
      expect((await code({ challenge: await challenged(), code: first }).expect(401)).body.error).toBe('INVALID_SECOND_FACTOR_CODE');
      // Lower case, no dash, spaces, and the letters that look like digits.
      const typed = second.replace('-', ' ').toLowerCase().replaceAll('0', 'o').replaceAll('1', 'l');
      await code({ challenge: await challenged(), code: typed }).expect(200);

      const session: AuthResponse = (await code({ challenge: await challenged(), code: app.code(secret) }).expect(200)).body;
      expect((await t.http().get('/api/users/me/second-factor').set('Authorization', `Bearer ${session.tokens.accessToken}`).expect(200)).body.recoveryCodesLeft).toBe(8);
    });

    it('still, after the password was reset by mail: whoever reads the mailbox does not hold the app', async () => {
      await t.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256('a-reset-link'), expiresAt: new Date(Date.now() + 60_000) } });

      await auth.confirmPasswordReset({ token: 'a-reset-link', password: 'Another-Passw0rd' });

      const answer = (await t.http().post('/api/auth/login').send({ email: user.email, password: 'Another-Passw0rd' }).expect(200)).body;
      expect(answer.tokens).toBeUndefined();
      await code({ challenge: answer.secondFactor.challenge, code: app.code(secret) }).expect(200);
    });
  });

  describe('is not a matter of guessing', () => {
    let secret: string;
    let recoveryCodes: string[];

    beforeEach(async () => {
      ({ secret, recoveryCodes } = await aSecondFactor(t, user, app));
    });

    /** Answer a new challenge with `given`; what the application said, as a status and an error. */
    const tried = async (given: string): Promise<{ status: number; error?: string; retryAfter?: string }> => {
      const res = await code({ challenge: await challenged(), code: given });
      return { status: res.status, error: res.body.error, retryAfter: res.headers['retry-after'] };
    };
    const wrong = () => tried(app.wrongCode(secret));

    it('after the fifth wrong code in a row the next has to wait, right or wrong', async () => {
      for (let n = 0; n < 5; n += 1) expect(await wrong()).toMatchObject({ status: 401, error: 'INVALID_SECOND_FACTOR_CODE' });

      expect(await tried(app.code(secret))).toEqual({ status: 429, error: 'TOO_MANY_ATTEMPTS', retryAfter: '30' });
      app.wait(29);
      expect(await tried(app.code(secret))).toMatchObject({ status: 429, retryAfter: '1' });
      app.wait(2);
      expect(await tried(app.code(secret))).toMatchObject({ status: 200 });
    });

    it('wherever the wrong codes come from and whichever challenge they answer: the count is the account\'s', async () => {
      for (let n = 0; n < 5; n += 1) await wrong();

      expect((await factorOf()).failures).toBe(5);
      expect(await t.prisma.signInChallenge.count({ where: { userId: user.id, usedAt: null } })).toBe(5);
    });

    it('a right code clears the count', async () => {
      for (let n = 0; n < 4; n += 1) await wrong();
      expect(await tried(app.code(secret))).toMatchObject({ status: 200 });
      app.wait(30);

      for (let n = 0; n < 4; n += 1) expect(await wrong()).toMatchObject({ status: 401 });
      expect(await factorOf()).toMatchObject({ failures: 4, blockedUntil: null });
    });

    it('every further wrong code doubles the wait, up to a day', async () => {
      for (let n = 0; n < 5; n += 1) await wrong();
      const waits: number[] = [];
      for (let n = 0; n < 3; n += 1) {
        app.wait(86_400);
        await wrong();
        waits.push(Math.round(((await factorOf()).blockedUntil!.getTime() - app.now()) / 1000));
      }
      expect(waits).toEqual([60, 120, 240]);

      await t.prisma.secondFactor.update({ where: { userId: user.id }, data: { failures: 40, blockedUntil: null } });
      await wrong();
      expect(Math.round(((await factorOf()).blockedUntil!.getTime() - app.now()) / 1000)).toBe(86_400);
    });

    it('many codes sent at once are looked at one after another, and no more of them than one by one', async () => {
      const challenges = await Promise.all(Array.from({ length: 12 }, () => challenged()));
      const guess = app.wrongCode(secret);

      const answers = await race(12, (index) => code({ challenge: challenges[index]!, code: guess }).then((res) => res.status));

      const statuses = answers.map((answer) => (answer.status === 'fulfilled' ? answer.value : 0)).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429, 429, 429]);
      expect((await factorOf()).failures).toBe(5);
    });

    it('a recovery code is looked at while codes from the app wait, and ends the wait', async () => {
      for (let n = 0; n < 5; n += 1) await wrong();
      expect(await tried(app.code(secret))).toMatchObject({ status: 429 });

      expect(await tried(recoveryCodes[0]!)).toMatchObject({ status: 200 });

      expect(await factorOf()).toMatchObject({ failures: 0, blockedUntil: null });
      expect(await tried(app.code(secret))).toMatchObject({ status: 200 });
    });

    it('a wrong recovery code is refused and not counted: there are too many to guess one', async () => {
      for (let n = 0; n < 7; n += 1) expect(await tried('ABCDE-FGHJK')).toMatchObject({ status: 401, error: 'INVALID_SECOND_FACTOR_CODE' });

      expect(await factorOf()).toMatchObject({ failures: 0, blockedUntil: null });
    });
  });

  describe('is part of what a session of the account is', () => {
    it('one that did not pass it is none, however it came to be', async () => {
      await aSecondFactor(t, user, app);
      const slipped = await sessions.open({ id: user.id, displayName: 'User', role: 'user', emailVerified: true }, user.email, 'Chrome · Windows');

      await t.http().get('/api/users/me').set('Authorization', `Bearer ${slipped.tokens.accessToken}`).expect(401);
      await expect(sessions.refresh(slipped.tokens.refreshToken)).rejects.toMatchObject({ response: { error: 'INVALID_REFRESH' } });
      expect((await sessions.list(user.id)).map((session) => session.label)).toEqual([null]);
    });

    it('and an account without a second factor is asked for none', async () => {
      const session: AuthResponse = (await password().expect(200)).body;

      expect(session.tokens.accessToken).toBeDefined();
      expect((await t.prisma.refreshToken.findFirstOrThrow({ where: { familyId: session.sessionId } })).secondFactorAt).toBeNull();
    });
  });

  describe('is taken away again', () => {
    let secret: string;
    let recoveryCodes: string[];

    beforeEach(async () => {
      ({ secret, recoveryCodes } = await aSecondFactor(t, user, app));
    });

    const switchOff = (body: { currentPassword: string; code: string }) => t.http().delete('/api/users/me/second-factor').set(as(user)).send(body);
    const newCodes = (body: { currentPassword: string; code: string }) => t.http().post('/api/users/me/second-factor/recovery-codes').set(as(user)).send(body);

    it('by the holder, with the password and a code: signing in then takes the password alone', async () => {
      await switchOff({ currentPassword: user.password, code: app.code(secret) }).expect(204);

      expect(await state()).toEqual({ enabled: false, since: null, recoveryCodesLeft: 0 });
      expect(await t.prisma.recoveryCode.count()).toBe(0);
      expect((await password().expect(200)).body.tokens.accessToken).toBeDefined();
    });

    it('not with the password alone, and not with a code alone', async () => {
      expect((await switchOff({ currentPassword: 'not-the-password', code: app.code(secret) }).expect(401)).body.error).toBe('INVALID_PASSWORD');
      expect((await switchOff({ currentPassword: user.password, code: app.wrongCode(secret) }).expect(401)).body.error).toBe('INVALID_SECOND_FACTOR_CODE');
      await t.http().delete('/api/users/me/second-factor').set(as(user)).send({ currentPassword: user.password }).expect(400);

      expect((await state()).enabled).toBe(true);
    });

    it('with a recovery code in the place of the app, for a holder who lost it', async () => {
      await switchOff({ currentPassword: user.password, code: recoveryCodes[3]! }).expect(204);

      expect((await state()).enabled).toBe(false);
    });

    it('and a challenge from before no longer leads anywhere: the password alone signs in now', async () => {
      const challenge = await challenged();
      const still = app.code(secret);

      await switchOff({ currentPassword: user.password, code: recoveryCodes[0]! }).expect(204);

      expect((await code({ challenge, code: still }).expect(401)).body.error).toBe('INVALID_SIGN_IN_CHALLENGE');
    });

    it('or its recovery codes are replaced: ten new ones, and none of the old works', async () => {
      const replaced: string[] = (await newCodes({ currentPassword: user.password, code: app.code(secret) }).expect(200)).body.recoveryCodes;

      expect(replaced).toHaveLength(10);
      expect(replaced.filter((recoveryCode) => recoveryCodes.includes(recoveryCode))).toEqual([]);
      expect((await code({ challenge: await challenged(), code: recoveryCodes[0]! }).expect(401)).body.error).toBe('INVALID_SECOND_FACTOR_CODE');
      await code({ challenge: await challenged(), code: replaced[0]! }).expect(200);
      expect((await newCodes({ currentPassword: 'not-the-password', code: replaced[1]! }).expect(401)).body.error).toBe('INVALID_PASSWORD');
    });

    it('which an account without one cannot ask for', async () => {
      const other = await aUser(t);
      const proof = { currentPassword: other.password, code: '123456' };

      expect((await t.http().delete('/api/users/me/second-factor').set(as(other)).send(proof).expect(409)).body.error).toBe('SECOND_FACTOR_NOT_ON');
      expect((await t.http().post('/api/users/me/second-factor/recovery-codes').set(as(other)).send(proof).expect(409)).body.error).toBe('SECOND_FACTOR_NOT_ON');
    });

    describe('by the operator, for a holder who lost the app and the codes', () => {
      const remove = (email: string) => t.http().delete('/api/admin/accounts/second-factor').set(asAdmin).send({ email });

      it('by the address of the account, however it is written', async () => {
        await remove(user.email.toUpperCase()).expect(204);

        expect(await t.prisma.secondFactor.count()).toBe(0);
        expect((await password().expect(200)).body.tokens.accessToken).toBeDefined();
      });

      it('and says so when no account of that address has one', async () => {
        const other = await aUser(t);

        expect((await remove(other.email).expect(404)).body.error).toBe('SECOND_FACTOR_NOT_FOUND');
        expect((await remove('nobody@example.test').expect(404)).body.error).toBe('SECOND_FACTOR_NOT_FOUND');
        expect((await state()).enabled).toBe(true);
      });

      it('not by anybody else', async () => {
        await t.http().delete('/api/admin/accounts/second-factor').send({ email: user.email }).expect(401);
        await t.http().delete('/api/admin/accounts/second-factor').set(as(user)).send({ email: user.email }).expect(401);

        expect((await state()).enabled).toBe(true);
      });
    });
  });

  it('leaves no challenge behind that nobody can answer any more', async () => {
    const { secret } = await aSecondFactor(t, user, app);
    const used = await challenged();
    await auth.finishLogin({ challenge: used, code: app.code(secret) });
    const forgotten = await challenged();
    const open = await challenged();
    await t.prisma.signInChallenge.updateMany({ where: { tokenHash: sha256(forgotten) }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await t.app.get(AccountSecondFactor).prune()).toBe(2);

    expect((await t.prisma.signInChallenge.findMany()).map((challenge) => challenge.tokenHash)).toEqual([sha256(open)]);
  });
});
