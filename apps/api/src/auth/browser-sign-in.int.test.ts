// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import type { AccountSession, AuthResponse, BrowserCode } from '@diet-app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anAuthenticator, aSecondFactor } from '../testing/authenticator.js';
import { resetDatabase } from '../testing/database.js';
import { aSession, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { BrowserSignIn } from './browser-sign-in.service.js';
import { type OpenedSession, SessionsService } from './sessions.service.js';

// The address the test application is reached at by browsers.
const WEB = 'http://localhost:3000';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DAY = 86_400;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The cookies an answer sets, by name: the value and the attributes of each. */
function cookiesOf(res: {
  headers: Record<string, unknown>;
}): Record<string, { value: string; attributes: string[] }> {
  const lines = ([] as string[]).concat(
    (res.headers['set-cookie'] as string[] | string | undefined) ?? [],
  );
  return Object.fromEntries(
    lines.map((line) => {
      const [pair, ...attributes] = line.split('; ');
      const at = pair!.indexOf('=');
      return [pair!.slice(0, at), { value: decodeURIComponent(pair!.slice(at + 1)), attributes }];
    }),
  );
}

describe('a browser signed in from an application', () => {
  let t: TestApp;
  let browsers: BrowserSignIn;
  let user: TestUser;
  /** The session of the application on the phone. */
  let app: OpenedSession;

  beforeAll(async () => {
    t = await createTestApp();
    browsers = t.app.get(BrowserSignIn);
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    user = await aUser(t);
    app = await aSession(t, user);
  });

  const askCode = (refreshToken: string) =>
    t.http().post('/api/auth/browser-code').send({ refreshToken });
  const codeOf = async (refreshToken = app.tokens.refreshToken): Promise<BrowserCode> =>
    (await askCode(refreshToken).expect(200)).body;
  const whose = (code: string, origin = WEB) =>
    t.http().post('/api/auth/browser-sign-in/account').set('Origin', origin).send({ code });
  const signIn = (
    code: string,
    { cookie, origin = WEB }: { cookie?: string; origin?: string } = {},
  ) => {
    const request = t
      .http()
      .post('/api/auth/browser-sign-in')
      .set({ Origin: origin, 'User-Agent': ANDROID_CHROME });
    return (cookie ? request.set('Cookie', `diet_refresh=${cookie}`) : request).send({ code });
  };
  const refresh = (refreshToken: string) =>
    t.http().post('/api/auth/refresh').send({ refreshToken });
  const sessionsOf = async (accessToken: string): Promise<AccountSession[]> =>
    (
      await t
        .http()
        .get('/api/users/me/sessions')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200)
    ).body;

  describe('gets a code', () => {
    it("for the refresh token of its session, with the session's next pair, as a refresh gives it", async () => {
      const res = await askCode(app.tokens.refreshToken).expect(200);
      const answer = res.body as BrowserCode;

      expect(answer.code).toMatch(/^[0-9a-f]{64}$/);
      expect(answer.codeExpiresIn).toBe(60);
      expect(answer.sessionId).toBe(app.sessionId);
      expect(answer.user.email).toBe(user.email);
      expect(answer.tokens.refreshToken).toMatch(/^[0-9a-f]{96}$/);
      expect(answer.tokens.refreshToken).not.toBe(app.tokens.refreshToken);
      // The token it showed is used up: shown again a moment later, it is taken for a second request of the same client.
      expect((await refresh(app.tokens.refreshToken).expect(409)).body.error).toBe(
        'SESSION_JUST_REFRESHED',
      );
      await refresh(answer.tokens.refreshToken!).expect(200);
    });

    it('kept as a hash alone', async () => {
      const { code } = await codeOf();

      const rows = await t.prisma.browserSignInCode.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.codeHash).toBe(sha256(code));
      expect(JSON.stringify(rows)).not.toContain(code);
    });

    it('for no access token, and for no refresh token that is not good', async () => {
      expect((await askCode(app.tokens.accessToken).expect(401)).body.error).toBe(
        'INVALID_REFRESH',
      );
      await t
        .http()
        .post('/api/auth/logout')
        .send({ refreshToken: app.tokens.refreshToken })
        .expect(204);
      expect((await askCode(app.tokens.refreshToken).expect(401)).body.error).toBe(
        'INVALID_REFRESH',
      );
      await t.http().post('/api/auth/browser-code').send({}).expect(400);
      expect(await t.prisma.browserSignInCode.count({ where: { userId: user.id } })).toBe(0);
    });

    it('thirty times in an hour for one account at most, and the thirty-first leaves the token it showed as it was', async () => {
      let token = app.tokens.refreshToken;
      for (let i = 0; i < 30; i += 1) token = (await browsers.codeFor(token)).tokens.refreshToken;

      const refused = await askCode(token).expect(429);

      expect(refused.body.error).toBe('BROWSER_CODES_USED_UP');
      expect(await t.prisma.browserSignInCode.count({ where: { userId: user.id } })).toBe(30);
      // Nothing of the session moved: the token is still the one to go on with.
      await refresh(token).expect(200);
      // Another account asks for its own.
      const other = await aSession(t, await aUser(t));
      await askCode(other.tokens.refreshToken).expect(200);
    });

    it('again once the codes of the hour before are older than an hour', async () => {
      let token = app.tokens.refreshToken;
      for (let i = 0; i < 30; i += 1) token = (await browsers.codeFor(token)).tokens.refreshToken;
      await t.prisma.browserSignInCode.updateMany({
        where: { userId: user.id },
        data: { createdAt: new Date(Date.now() - 61 * 60_000) },
      });

      await askCode(token).expect(200);
    });
  });

  describe('is shown whose account a code is for', () => {
    it('without the code being used', async () => {
      const { code } = await codeOf();

      expect((await whose(code).expect(200)).body).toEqual({
        email: user.email,
        displayName: expect.any(String),
      });
      expect((await whose(code).expect(200)).body.email).toBe(user.email);
      await signIn(code).expect(200);
    });

    it("by the application's own pages alone", async () => {
      const { code } = await codeOf();

      expect((await whose(code, 'https://elsewhere.example').expect(403)).body.error).toBe(
        'ORIGIN_NOT_ALLOWED',
      );
    });
  });

  describe('is signed in with a code', () => {
    it("to a session of its own in cookies, for a day, listed with the browser's name", async () => {
      const { code, tokens } = await codeOf();

      const res = await signIn(code).expect(200);

      const body = res.body as AuthResponse;
      const { diet_refresh: refreshCookie, diet_session: marker } = cookiesOf(res);
      expect(refreshCookie!.value).toMatch(/^[0-9a-f]{96}$/);
      expect(refreshCookie!.attributes).toEqual(
        expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/api/auth', `Max-Age=${DAY}`]),
      );
      expect(marker!.value).toBe('1');
      expect(body.tokens).toEqual({
        accessToken: expect.any(String),
        expiresIn: 900,
        refreshExpiresIn: DAY,
      });
      expect(JSON.stringify(body)).not.toContain(refreshCookie!.value);
      expect(body.user.email).toBe(user.email);
      expect(body.sessionId).not.toBe(app.sessionId);
      const listed = await sessionsOf(tokens.accessToken);
      const browser = listed.find((session) => session.id === body.sessionId);
      expect(browser?.label).toBe('Chrome · Android');
      expect(
        Math.abs(new Date(browser!.endsAt).getTime() - (Date.now() + DAY * 1000)),
      ).toBeLessThan(60_000);
    });

    it('once', async () => {
      const { code } = await codeOf();
      await signIn(code).expect(200);

      expect((await signIn(code).expect(401)).body.error).toBe('INVALID_BROWSER_CODE');
      expect((await whose(code).expect(401)).body.error).toBe('INVALID_BROWSER_CODE');
    });

    it('once, when another request uses the code between the look at it and its use', async () => {
      const { code } = await codeOf();
      const sessions = t.app.get(SessionsService);
      const isOpen = sessions.isOpen.bind(sessions);
      // The look at the code is followed by the look at its session: another request takes the code in between.
      vi.spyOn(sessions, 'isOpen').mockImplementationOnce(async (userId, sessionId) => {
        await t.prisma.browserSignInCode.updateMany({
          where: { codeHash: sha256(code) },
          data: { usedAt: new Date() },
        });
        return isOpen(userId, sessionId);
      });

      const res = await signIn(code);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_BROWSER_CODE');
      expect(cookiesOf(res)).toEqual({});
    });

    it('within a minute', async () => {
      const { code } = await codeOf();
      await t.prisma.browserSignInCode.updateMany({
        where: { codeHash: sha256(code) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect((await whose(code).expect(401)).body.error).toBe('INVALID_BROWSER_CODE');
      expect((await signIn(code).expect(401)).body.error).toBe('INVALID_BROWSER_CODE');
    });

    it('while the session that asked for it is open', async () => {
      const { code, tokens } = await codeOf();
      await t
        .http()
        .post('/api/auth/logout')
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);

      expect((await whose(code).expect(401)).body.error).toBe('INVALID_BROWSER_CODE');
      expect((await signIn(code).expect(401)).body.error).toBe('INVALID_BROWSER_CODE');
    });

    it('with a code that was given, and none other', async () => {
      expect((await signIn('0'.repeat(64)).expect(401)).body.error).toBe('INVALID_BROWSER_CODE');
      await signIn('').expect(400);
    });

    it("by the application's own pages alone, and a refused page leaves the code to be used", async () => {
      const { code } = await codeOf();

      expect(
        (await signIn(code, { origin: 'https://elsewhere.example' }).expect(403)).body.error,
      ).toBe('ORIGIN_NOT_ALLOWED');
      await signIn(code).expect(200);
    });

    it('in the place of the session the browser had, of another account or of the same', async () => {
      const someoneElse = await aSession(t, await aUser(t));
      const ownBrowser = await aSession(t, user);

      const first = await codeOf();
      await signIn(first.code, { cookie: someoneElse.tokens.refreshToken }).expect(200);
      const second = await codeOf(first.tokens.refreshToken);
      await signIn(second.code, { cookie: ownBrowser.tokens.refreshToken }).expect(200);

      expect((await refresh(someoneElse.tokens.refreshToken).expect(401)).body.error).toBe(
        'INVALID_REFRESH',
      );
      expect((await refresh(ownBrowser.tokens.refreshToken).expect(401)).body.error).toBe(
        'INVALID_REFRESH',
      );
    });

    it('to a session that refreshes within its day and never past it', async () => {
      const res = await signIn((await codeOf()).code).expect(200);

      const next = await t
        .http()
        .post('/api/auth/refresh')
        .set({ Origin: WEB, Cookie: `diet_refresh=${cookiesOf(res).diet_refresh!.value}` })
        .expect(200);

      expect((next.body as AuthResponse).tokens.refreshExpiresIn).toBeLessThanOrEqual(DAY);
      const family = await t.prisma.refreshToken.findFirstOrThrow({
        where: { familyId: (res.body as AuthResponse).sessionId },
      });
      expect(family.familyExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY * 1000);
    });

    it('to a session that counts for an account with a second factor, as the session that asked passed it', async () => {
      await aSecondFactor(t, user, anAuthenticator(t));
      // Setting the factor up kept the session it was set up from, and ended the others.
      const { code } = await codeOf(user.refreshToken);

      const body = (await signIn(code).expect(200)).body as AuthResponse;

      await t
        .http()
        .get('/api/users/me')
        .set('Authorization', `Bearer ${body.tokens.accessToken}`)
        .expect(200);
    });
  });

  it('removes the codes of more than a day ago, and keeps those an hour is still counted from', async () => {
    const old = await codeOf();
    const recent = await codeOf(old.tokens.refreshToken);
    await t.prisma.browserSignInCode.updateMany({
      where: { codeHash: sha256(old.code) },
      data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
    });

    expect(await browsers.prune()).toBe(1);

    const left = await t.prisma.browserSignInCode.findMany({ where: { userId: user.id } });
    expect(left.map((row) => row.codeHash)).toEqual([sha256(recent.code)]);
  });
});
