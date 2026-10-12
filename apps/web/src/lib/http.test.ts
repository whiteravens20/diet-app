// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiClient, localDate } from './http';

describe('a request to the API, whoever asks', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const sent = (call = 0): { url: string; init: RequestInit; headers: Headers } => {
    const [url, init] = fetchMock.mock.calls[call]! as [string, RequestInit];
    return { url, init, headers: new Headers(init.headers) };
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'NEXT_LOCALE=; Max-Age=0; Path=/';
  });

  it('goes to the part of the API its client speaks to, with the session cookie of the application\'s own address', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, {})));

    await apiClient('').get('/profiles');
    await apiClient('/admin').get('/stats');
    await apiClient('/review').post('/auth', { password: 'p', label: 'l' });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/profiles', '/api/admin/stats', '/api/review/auth']);
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).credentials)).toEqual(['same-origin', 'same-origin', 'same-origin']);
    expect(sent(2).init).toMatchObject({ method: 'POST', body: JSON.stringify({ password: 'p', label: 'l' }) });
  });

  it('says in which language the application is shown, and which day it is for the user', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, {})));

    await apiClient('/admin').get('/stats');
    document.cookie = 'NEXT_LOCALE=pl; Path=/';
    await apiClient('/review').get('/status');

    expect(sent(0).headers.get('accept-language')).toBe('en');
    expect(sent(1).headers.get('accept-language')).toBe('pl');
    expect(sent(1).headers.get('x-client-date')).toBe(localDate());
    expect(sent(1).headers.get('content-type')).toBe('application/json');
  });

  it('lets whoever asks put the proof of it into the request', async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    const client = apiClient('', { sign: async (headers) => headers.set('authorization', 'Bearer a-token') });

    await client.put('/profiles/p', { name: 'Me' });

    expect(sent().headers.get('authorization')).toBe('Bearer a-token');
    expect(sent().init).toMatchObject({ method: 'PUT', body: JSON.stringify({ name: 'Me' }) });
  });

  it('answers with nothing for an answer without a body', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('', { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-length': '0' } }));
    const client = apiClient('');

    expect(await client.delete('/a')).toBeUndefined();
    expect(await client.post('/b')).toBeUndefined();
    expect(await client.get('/c')).toBeUndefined();
  });

  it('turns a refusal into one kind of error, with everything the API said about it', async () => {
    fetchMock.mockResolvedValue(
      json(429, { error: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong codes.', issues: [{ path: 'code', message: 'x' }], details: { left: 0 } }, { 'retry-after': '240' }),
    );

    const refused = await apiClient('/admin').post('/session', {}).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(ApiClientError);
    expect(refused).toMatchObject({
      status: 429,
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many wrong codes.',
      issues: [{ path: 'code', message: 'x' }],
      retryAfterSeconds: 240,
      details: { left: 0 },
    });
  });

  it('names a refusal that is none of the API\'s own, and a request nothing answered', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const client = apiClient('/review');

    expect(await client.get('/status').catch((err: unknown) => err)).toMatchObject({ status: 502, code: 'ERROR', message: 'Bad Gateway' });
    expect(await client.get('/status').catch((err: unknown) => err)).toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('asks whoever asks about a 401, and sends the request once more when the proof was renewed', async () => {
    const renewed = vi.fn().mockResolvedValue(true);
    fetchMock.mockImplementation(() => Promise.resolve(json(401, { error: 'UNAUTHORIZED', message: 'Sign in.' })));

    const refused = await apiClient('', { renewed }).get('/users/me').catch((err: unknown) => err);

    expect(renewed).toHaveBeenCalledTimes(1);
    expect(renewed).toHaveBeenCalledWith('UNAUTHORIZED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refused).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('does not send a request again for an identity that has nothing to renew, or that could not', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(401, { error: 'INVALID_ADMIN_SESSION', message: 'Ended.' })));

    await apiClient('/admin').get('/stats').catch(() => undefined);
    await apiClient('', { renewed: async () => false }).get('/users/me').catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('hands over a file as it came, and refuses as any other request does', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"a":1}', { status: 200 })).mockResolvedValueOnce(json(401, { error: 'INVALID_ADMIN_SESSION', message: 'Ended.' }));
    const client = apiClient('/admin');

    expect(await (await client.download('/drafts/ship/current-overrides')).text()).toBe('{"a":1}');
    expect(await client.download('/drafts/ship/current-overrides').catch((err: unknown) => err)).toMatchObject({ status: 401, code: 'INVALID_ADMIN_SESSION' });
  });
});
