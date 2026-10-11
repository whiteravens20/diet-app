// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { AuthResponse } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AuthService } from './auth.service.js';
import { sessionCookies } from './session-cookies.js';
import { SessionsService } from './sessions.service.js';

// The address the test application is reached at by browsers.
const WEB = 'http://localhost:3000';
const COOKIE_SESSION = { 'X-Session-Transport': 'cookie', Origin: WEB };

/** The cookies an answer sets, by name: the value and the attributes of each. */
function cookiesOf(res: { headers: Record<string, unknown> }): Record<string, { value: string; attributes: string[] }> {
  const lines = ([] as string[]).concat((res.headers['set-cookie'] as string[] | string | undefined) ?? []);
  return Object.fromEntries(
    lines.map((line) => {
      const [pair, ...attributes] = line.split('; ');
      const at = pair!.indexOf('=');
      return [pair!.slice(0, at), { value: decodeURIComponent(pair!.slice(at + 1)), attributes }];
    }),
  );
}

describe('the session of a browser', () => {
  let t: TestApp;
  let sessions: SessionsService;
  let user: TestUser;
  let refreshCookie: string;

  beforeAll(async () => {
    t = await createTestApp();
    sessions = t.app.get(SessionsService);
    await resetDatabase(t.prisma);
    user = await aUser(t);
  });

  afterAll(async () => {
    await t.close();
  });

  const signIn = () => t.http().post('/api/auth/login').set(COOKIE_SESSION).send({ email: user.email, password: user.password });
  const refresh = (cookie: string | null, headers: Record<string, string> = { Origin: WEB }) => {
    const request = t.http().post('/api/auth/refresh').set(headers);
    return cookie === null ? request.send() : request.set('Cookie', `diet_refresh=${cookie}`).send();
  };

  beforeEach(async () => {
    // A session as a sign-in leaves one, without a sign-in each time: the route counts those.
    refreshCookie = (await t.app.get(AuthService).login({ email: user.email, password: user.password })).tokens.refreshToken;
  });

  it('gets its refresh token in a cookie no script can read, sent to the routes that use it and nowhere else', async () => {
    const res = await signIn().expect(200);
    const { diet_refresh: refreshToken, diet_session: marker } = cookiesOf(res);

    expect(refreshToken!.value).toMatch(/^[0-9a-f]{96}$/);
    expect(refreshToken!.attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/api/auth']));
    expect(refreshToken!.attributes.find((attribute) => attribute.startsWith('Max-Age='))).toBe(`Max-Age=${30 * 86_400}`);
    // The marker says that there is a session, to scripts and to the route guard, and holds nothing else.
    expect(marker!.value).toBe('1');
    expect(marker!.attributes).toEqual(expect.arrayContaining(['SameSite=Strict', 'Path=/']));
    expect(marker!.attributes).not.toContain('HttpOnly');
    // The token is in the cookie alone.
    const body = res.body as AuthResponse;
    expect(body.tokens).toEqual({ accessToken: expect.any(String), expiresIn: 900, refreshExpiresIn: 30 * 86_400 });
    expect(JSON.stringify(body)).not.toContain(refreshToken!.value);
  });

  it('is not what another client gets: without asking for it, the token comes in the answer and no cookie is set', async () => {
    const res = await t.http().post('/api/auth/login').send({ email: user.email, password: user.password }).expect(200);

    expect(cookiesOf(res)).toEqual({});
    expect((res.body as AuthResponse).tokens.refreshToken).toMatch(/^[0-9a-f]{96}$/);
  });

  it('goes on with the cookie: a new access token, and the next refresh token in the cookie again', async () => {
    const res = await refresh(refreshCookie).expect(200);

    const next = cookiesOf(res).diet_refresh!.value;
    expect(next).not.toBe(refreshCookie);
    expect((res.body as AuthResponse).tokens.refreshToken).toBeUndefined();
    await refresh(next).expect(200);
  });

  it.each([
    ['from another site', { Origin: 'https://elsewhere.example' }],
    ['that does not say where it comes from', {}],
    ['that names the site as part of another address', { Origin: `${WEB}.elsewhere.example` }],
  ])('is not carried on by a request %s', async (_name, headers) => {
    const refused = await refresh(refreshCookie, headers);

    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('ORIGIN_NOT_ALLOWED');
    expect(cookiesOf(refused)).toEqual({});
    // Nothing was used up: the session goes on from where it was.
    await refresh(refreshCookie).expect(200);
  });

  it('is refused without a cookie and without a token', async () => {
    expect((await refresh(null).expect(401)).body.error).toBe('INVALID_REFRESH');
  });

  it('loses its cookies when it has ended', async () => {
    await sessions.end(refreshCookie);

    const refused = await refresh(refreshCookie).expect(401);

    const cleared = cookiesOf(refused);
    expect(cleared.diet_refresh).toMatchObject({ value: '', attributes: expect.arrayContaining(['Max-Age=0', 'Path=/api/auth']) });
    expect(cleared.diet_session).toMatchObject({ value: '', attributes: expect.arrayContaining(['Max-Age=0', 'Path=/']) });
  });

  it('keeps its cookies when two tabs refresh in the same moment', async () => {
    await refresh(refreshCookie).expect(200);

    const second = await refresh(refreshCookie);

    expect(second.status).toBe(409);
    expect(cookiesOf(second)).toEqual({});
  });

  it('is signed out of with the cookie, which is taken away', async () => {
    const res = await t.http().post('/api/auth/logout').set({ Origin: WEB }).set('Cookie', `diet_refresh=${refreshCookie}`).send().expect(204);

    expect(cookiesOf(res).diet_refresh!.attributes).toContain('Max-Age=0');
    expect(cookiesOf(res).diet_session!.attributes).toContain('Max-Age=0');
    await refresh(refreshCookie).expect(401);
  });

  it('is not signed out of from another site', async () => {
    await t.http().post('/api/auth/logout').set({ Origin: 'https://elsewhere.example' }).set('Cookie', `diet_refresh=${refreshCookie}`).send().expect(403);

    await refresh(refreshCookie).expect(200);
  });

  it('begins the same way for a new account', async () => {
    const res = await t.http().post('/api/auth/register').set(COOKIE_SESSION).send({ email: 'browser@example.test', password: 'Brand-New-Passw0rd', displayName: 'Browser' }).expect(201);

    expect(cookiesOf(res).diet_refresh!.attributes).toContain('HttpOnly');
    expect((res.body as AuthResponse).tokens.refreshToken).toBeUndefined();
  });

  it('still takes a token in the request from a client that keeps its own', async () => {
    const res = await t.http().post('/api/auth/refresh').send({ refreshToken: user.refreshToken }).expect(200);

    expect(cookiesOf(res)).toEqual({});
    expect((res.body as AuthResponse).tokens.refreshToken).toMatch(/^[0-9a-f]{96}$/);
  });
});

describe('the cookies of a session', () => {
  const tokens = { refreshToken: 'ab'.repeat(48), refreshExpiresIn: 3600 };

  it('are sent over an encrypted connection only where the application is served over one', () => {
    for (const line of sessionCookies(tokens, 'https://diet.example.test')) expect(line.split('; ')).toContain('Secure');
    for (const line of sessionCookies(tokens, 'http://192.0.2.10:3000')) expect(line.split('; ')).not.toContain('Secure');
  });

  it('last as long as the refresh token does', () => {
    for (const line of sessionCookies(tokens, 'https://diet.example.test')) expect(line.split('; ')).toContain('Max-Age=3600');
  });
});
