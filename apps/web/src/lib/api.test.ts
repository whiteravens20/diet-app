// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDate, waitOf } from './http';

describe('the day it is for the user', () => {
  it('is read off the clock where the user is, not in UTC', () => {
    // The first of March, half an hour before midnight on the user's clock, whatever the zone of the machine.
    const lateEvening = new Date(2026, 2, 1, 23, 30);

    expect(localDate(lateEvening)).toBe('2026-03-01');
    expect(localDate(new Date(2026, 11, 31, 0, 5))).toBe('2026-12-31');
    expect(localDate(new Date(2026, 0, 9, 12))).toBe('2026-01-09');
  });
});

describe('how long a request that was held up has to wait', () => {
  it('is given in whole minutes, rounded up, when it is long', () => {
    expect(waitOf(429, 900)).toEqual({ unit: 'minutes', count: 15 });
    expect(waitOf(429, 91)).toEqual({ unit: 'minutes', count: 2 });
  });

  it('is given in seconds up to a minute and a half', () => {
    expect(waitOf(429, 30)).toEqual({ unit: 'seconds', count: 30 });
    expect(waitOf(429, 90)).toEqual({ unit: 'seconds', count: 90 });
    expect(waitOf(429, 0.4)).toEqual({ unit: 'seconds', count: 1 });
  });

  it('is not given for a wait nobody stated or for another refusal', () => {
    expect(waitOf(429, undefined)).toBeNull();
    expect(waitOf(503, 900)).toBeNull();
  });
});

describe('a request of the web application', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const aSession = {
    user: {},
    tokens: { accessToken: 'fresh-token', expiresIn: 900, refreshExpiresIn: 2_592_000 },
    sessionId: '11111111-1111-4111-8111-111111111111',
  };
  const bearerOf = (call: unknown[]): string | null =>
    new Headers((call[1] as RequestInit).headers).get('authorization');

  /** The client as a page that was just loaded has it. */
  async function aPage(signedIn: boolean) {
    vi.resetModules();
    document.cookie = signedIn ? 'diet_session=1; Path=/' : 'diet_session=; Max-Age=0; Path=/';
    const { api, COOKIE_SESSION } = await import('./api');
    const { session } = await import('./session');
    session.leave = vi.fn();
    return { api, session, COOKIE_SESSION };
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gets an access token first on a page that was just loaded, where the browser has a session', async () => {
    const { api } = await aPage(true);
    fetchMock
      .mockResolvedValueOnce(json(200, aSession))
      .mockResolvedValueOnce(json(200, { id: 'me' }));

    expect(await api.get('/users/me')).toEqual({ id: 'me' });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/auth/refresh',
      '/api/users/me',
    ]);
    expect(bearerOf(fetchMock.mock.calls[1]!)).toBe('Bearer fresh-token');
  });

  it('asks for nothing first and sends no token where the browser has no session', async () => {
    const { api } = await aPage(false);
    fetchMock.mockResolvedValue(json(200, { turnstile: { enabled: false } }));

    await api.get('/config');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bearerOf(fetchMock.mock.calls[0]!)).toBeNull();
  });

  it('gets the next token and sends the request again, once, when its token has run out', async () => {
    const { api, session } = await aPage(true);
    session.begin({
      ...aSession,
      tokens: { ...aSession.tokens, accessToken: 'stale-token' },
    } as never);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'UNAUTHORIZED' }))
      .mockResolvedValueOnce(json(200, aSession))
      .mockResolvedValueOnce(json(200, { ok: true }));

    expect(await api.get('/profiles')).toEqual({ ok: true });

    expect(fetchMock.mock.calls.map((call) => [call[0], bearerOf(call)])).toEqual([
      ['/api/profiles', 'Bearer stale-token'],
      ['/api/auth/refresh', null],
      ['/api/profiles', 'Bearer fresh-token'],
    ]);
  });

  it('answers with the refusal when the session cannot go on', async () => {
    const { api, session } = await aPage(true);
    session.begin(aSession as never);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'UNAUTHORIZED', message: 'no' }))
      .mockResolvedValueOnce(json(401, { error: 'INVALID_REFRESH' }));

    await expect(api.get('/profiles')).rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.leave).toHaveBeenCalled();
  });

  it('does not send a request again that was refused for what it said, such as a wrong password', async () => {
    const { api, session } = await aPage(true);
    session.begin(aSession as never);
    fetchMock.mockResolvedValueOnce(
      json(401, { error: 'INVALID_PASSWORD', message: 'Current password is incorrect.' }),
    );

    await expect(
      api.post('/users/me/password', { currentPassword: 'wrong', newPassword: 'whatever' }),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_PASSWORD' });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/users/me/password']);
    expect(session.leave).not.toHaveBeenCalled();
  });

  it('gets the next token when the server no longer takes the session of the old one for open', async () => {
    const { api, session } = await aPage(true);
    session.begin(aSession as never);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'INVALID_ACCESS_TOKEN' }))
      .mockResolvedValueOnce(json(200, aSession))
      .mockResolvedValueOnce(json(200, { ok: true }));

    expect(await api.get('/profiles')).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends what a removal has to say with it', async () => {
    const { api } = await aPage(false);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.delete('/users/me/second-factor', { currentPassword: 'secret', code: '123456' });
    await api.delete('/users/me/sessions');

    expect(
      fetchMock.mock.calls.map((call) => [
        (call[1] as RequestInit).method,
        (call[1] as RequestInit).body,
      ]),
    ).toEqual([
      ['DELETE', JSON.stringify({ currentPassword: 'secret', code: '123456' })],
      ['DELETE', undefined],
    ]);
  });

  it('says with every request which day it is for the user', async () => {
    const { api } = await aPage(false);
    fetchMock.mockImplementation(() => Promise.resolve(json(200, {})));

    await api.get('/meal-plans?profileId=p');
    await api.post('/meal-plans', { profileId: 'p' });

    for (const call of fetchMock.mock.calls) {
      expect(new Headers((call[1] as RequestInit).headers).get('x-client-date')).toBe(localDate());
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('signs in as a browser: it asks for its refresh token in a cookie', async () => {
    const { api, COOKIE_SESSION } = await aPage(false);
    fetchMock.mockResolvedValue(json(200, aSession));

    await api.post(
      '/auth/login',
      { email: 'user@example.test', password: 'secret' },
      COOKIE_SESSION,
    );

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('x-session-transport')).toBe('cookie');
    expect(init.credentials).toBe('same-origin');
  });
});
