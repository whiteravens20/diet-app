// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { AuthResponse } from '@diet-app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const anAnswer = (
  accessToken: string,
  sessionId = '11111111-1111-4111-8111-111111111111',
): AuthResponse => ({
  user: {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'user@example.test',
    displayName: 'User',
    role: 'user',
    emailVerified: true,
  },
  tokens: { accessToken, expiresIn: 900, refreshExpiresIn: 2_592_000 },
  sessionId,
});
const answered = (status: number, body: unknown = {}): Response =>
  status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

/** The module as a page that was just loaded has it, with the session cookie present or not. */
async function aPage(signedIn: boolean) {
  vi.resetModules();
  document.cookie = signedIn ? 'diet_session=1; Path=/' : 'diet_session=; Max-Age=0; Path=/';
  const { session } = await import('./session');
  session.leave = vi.fn();
  session.load = vi.fn();
  return session;
}

/** Another tab of the same browser: what it says reaches this page, and it hears what this page says. */
function anotherTab() {
  const tab = new BroadcastChannel('diet-app.session');
  const heard: unknown[] = [];
  tab.addEventListener('message', (event) => heard.push(event.data));
  return { tab, heard, close: () => tab.close() };
}
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('the session of the browser', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is there when the marker cookie says so', async () => {
    expect((await aPage(true)).exists()).toBe(true);
    expect((await aPage(false)).exists()).toBe(false);
  });

  it('keeps the access token in the memory of the page and nowhere a script could find it later', async () => {
    const session = await aPage(true);

    session.begin(anAnswer('access-1'));

    expect(session.accessToken).toBe('access-1');
    expect(session.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(JSON.stringify({ ...localStorage })).not.toContain('access-1');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('access-1');
    expect(document.cookie).not.toContain('access-1');
  });

  it('removes the tokens an earlier version left where scripts can read them', async () => {
    localStorage.setItem('diet-app.access', 'old-access');
    localStorage.setItem('diet-app.refresh', 'old-refresh');

    await aPage(true);

    expect(localStorage.getItem('diet-app.access')).toBeNull();
    expect(localStorage.getItem('diet-app.refresh')).toBeNull();
  });

  describe('getting the next access token', () => {
    it('asks with the cookie alone, and goes on with what it is given', async () => {
      const session = await aPage(true);
      fetchMock.mockResolvedValue(answered(200, anAnswer('access-2')));

      expect(await session.refresh()).toBe(true);

      expect(session.accessToken).toBe('access-2');
      // Finished by the browser even if the page goes away: its answer holds the next cookie.
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      });
    });

    it('asks once, however many requests of the page want a token at the same moment', async () => {
      const session = await aPage(true);
      fetchMock.mockResolvedValue(answered(200, anAnswer('access-2')));

      const results = await Promise.all([session.refresh(), session.refresh(), session.refresh()]);

      expect(results).toEqual([true, true, true]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('tries again a moment later when another request of the browser has just used the cookie', async () => {
      const session = await aPage(true);
      fetchMock
        .mockResolvedValueOnce(answered(409, { error: 'SESSION_JUST_REFRESHED' }))
        .mockResolvedValueOnce(answered(200, anAnswer('access-3')));

      expect(await session.refresh()).toBe(true);

      expect(session.accessToken).toBe('access-3');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up for now when the cookie stays used up, without ending the session: the next request tries again', async () => {
      vi.useFakeTimers();
      try {
        const session = await aPage(true);
        fetchMock.mockImplementation(() =>
          Promise.resolve(answered(409, { error: 'SESSION_JUST_REFRESHED' })),
        );

        const result = session.refresh();
        await vi.runAllTimersAsync();

        expect(await result).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(session.exists()).toBe(true);
        expect(session.unreachable).toBe(true);
        expect(session.leave).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('ends the session here and in the other tabs when the server refuses it, and leaves the page', async () => {
      const session = await aPage(true);
      session.begin(anAnswer('access-1'));
      const other = anotherTab();
      fetchMock.mockResolvedValue(answered(401, { error: 'INVALID_REFRESH' }));

      expect(await session.refresh()).toBe(false);
      await aMoment();

      expect(session.accessToken).toBeNull();
      expect(session.exists()).toBe(false);
      expect(session.leave).toHaveBeenCalledTimes(1);
      expect(other.heard).toContainEqual({ type: 'signed-out' });
      other.close();
    });

    it.each([
      ['is asked to wait', () => Promise.resolve(answered(429))],
      ['fails', () => Promise.resolve(answered(503))],
      ['cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
    ])(
      'keeps the session when the server %s: that says nothing about the session',
      async (_name, respond) => {
        const session = await aPage(true);
        session.begin(anAnswer('access-1'));
        fetchMock.mockImplementation(respond);

        expect(await session.refresh()).toBe(false);

        expect(session.accessToken).toBe('access-1');
        expect(session.exists()).toBe(true);
        expect(session.leave).not.toHaveBeenCalled();
      },
    );

    it('says that the session could not be reached, to whoever watches, until a try gets through', async () => {
      const session = await aPage(true);
      const told = vi.fn();
      session.subscribe(told);
      expect(session.unreachable).toBe(false);
      fetchMock.mockResolvedValueOnce(answered(503));

      await session.refresh();

      expect(session.unreachable).toBe(true);
      expect(told).toHaveBeenCalledTimes(1);

      fetchMock
        .mockResolvedValueOnce(answered(503))
        .mockResolvedValueOnce(answered(200, anAnswer('access-2')));
      const again = session.refresh();
      expect(session.unreachable).toBe(true);
      await again;
      expect(session.unreachable).toBe(true);

      await session.refresh();

      expect(session.unreachable).toBe(false);
      expect(session.accessToken).toBe('access-2');
    });

    it('says nothing of the kind of a session that was refused: that one has ended', async () => {
      const session = await aPage(true);
      fetchMock
        .mockResolvedValueOnce(answered(503))
        .mockResolvedValueOnce(answered(401, { error: 'INVALID_REFRESH' }));
      await session.refresh();

      await session.refresh();

      expect(session.unreachable).toBe(false);
      expect(session.exists()).toBe(false);
    });
  });

  describe('in several tabs', () => {
    it('takes the token another tab was given, without asking for one of its own', async () => {
      const session = await aPage(true);
      const other = anotherTab();
      const told = vi.fn();
      session.subscribe(told);

      other.tab.postMessage({
        type: 'token',
        accessToken: 'from-the-other-tab',
        sessionId: '33333333-3333-4333-8333-333333333333',
      });
      await aMoment();

      expect(session.accessToken).toBe('from-the-other-tab');
      expect(session.id).toBe('33333333-3333-4333-8333-333333333333');
      expect(told).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      other.close();
    });

    it('tells the other tabs the token it was given', async () => {
      const session = await aPage(true);
      const other = anotherTab();
      fetchMock.mockResolvedValue(answered(200, anAnswer('access-2')));

      await session.refresh();
      await aMoment();

      expect(other.heard).toContainEqual({
        type: 'token',
        accessToken: 'access-2',
        sessionId: '11111111-1111-4111-8111-111111111111',
      });
      other.close();
    });

    it('loads its page anew when another tab replaced the session, and leaves the cookies to the new one', async () => {
      const session = await aPage(true);
      session.begin(anAnswer('access-of-the-old-session'));
      const other = anotherTab();
      window.history.replaceState(null, '', '/settings?tab=sessions');

      other.tab.postMessage({ type: 'replaced' });
      await aMoment();

      expect(session.accessToken).toBeNull();
      expect(session.load).toHaveBeenCalledWith('/settings?tab=sessions');
      expect(session.leave).not.toHaveBeenCalled();
      expect(session.exists()).toBe(true);
      other.close();
      window.history.replaceState(null, '', '/');
    });

    it('tells the other tabs when this one replaced the session, and goes on with it', async () => {
      const session = await aPage(true);
      session.begin(anAnswer('access-of-the-old-session'));
      const other = anotherTab();

      session.replaced('/meal-plans?profile=p1');
      await aMoment();

      expect(other.heard).toContainEqual({ type: 'replaced' });
      expect(session.accessToken).toBeNull();
      expect(session.load).toHaveBeenCalledWith('/meal-plans?profile=p1');
      expect(session.exists()).toBe(true);
      other.close();
    });

    it('is signed out in every tab when one signs out', async () => {
      const session = await aPage(true);
      session.begin(anAnswer('access-1'));
      const other = anotherTab();

      other.tab.postMessage({ type: 'signed-out' });
      await aMoment();

      expect(session.accessToken).toBeNull();
      expect(session.leave).toHaveBeenCalledTimes(1);
      other.close();
    });
  });

  it('signs out by ending the session on the server, here and in the other tabs, and loads the sign-in page', async () => {
    const session = await aPage(true);
    session.begin(anAnswer('access-1'));
    const other = anotherTab();
    fetchMock.mockResolvedValue(answered(204));

    await session.signOut();
    await aMoment();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
    });
    expect(session.accessToken).toBeNull();
    expect(session.exists()).toBe(false);
    expect(other.heard).toContainEqual({ type: 'signed-out' });
    expect(session.load).toHaveBeenCalledWith('/login');
    other.close();
  });

  it('signs out here even when the server could not be told', async () => {
    const session = await aPage(true);
    session.begin(anAnswer('access-1'));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await session.signOut();

    expect(session.accessToken).toBeNull();
    expect(session.exists()).toBe(false);
    expect(session.load).toHaveBeenCalledWith('/login');
  });

  it('ends where the reader ended it: forgotten here and in the other tabs before the next page is loaded', async () => {
    const session = await aPage(true);
    session.begin(anAnswer('access-1'));
    const other = anotherTab();
    const held: (string | null)[] = [];
    session.load = vi.fn(() => held.push(session.accessToken));

    session.end('/');
    await aMoment();

    expect(session.load).toHaveBeenCalledWith('/');
    expect(held).toEqual([null]);
    expect(session.exists()).toBe(false);
    expect(other.heard).toContainEqual({ type: 'signed-out' });
    expect(fetchMock).not.toHaveBeenCalled();
    other.close();
  });

  describe('moving between pages', () => {
    const ORIGIN = 'https://app.example.test';

    /** The module with the browser at an address, and what it did to the address. */
    async function aPageAt(pathname: string, search = '') {
      vi.resetModules();
      const location = { origin: ORIGIN, pathname, search, assign: vi.fn(), replace: vi.fn() };
      vi.stubGlobal('location', location);
      const { session } = await import('./session');
      return { session, location };
    }

    it('loads a page anew in the place of this one, so that nothing the page held in memory comes along and Back does not lead to it', async () => {
      const { session, location } = await aPageAt('/login');

      session.load('/meal-plans?profile=0b1f');

      expect(location.replace).toHaveBeenCalledWith(`${ORIGIN}/meal-plans?profile=0b1f`);
      expect(location.assign).not.toHaveBeenCalled();
    });

    it.each([
      ['//elsewhere.example/dashboard', `${ORIGIN}/elsewhere.example/dashboard`],
      ['///elsewhere.example', `${ORIGIN}/elsewhere.example`],
      ['/\\elsewhere.example', `${ORIGIN}/elsewhere.example`],
      ['\\\\elsewhere.example', `${ORIGIN}/elsewhere.example`],
      ['https://elsewhere.example/', `${ORIGIN}/https://elsewhere.example/`],
      ['@elsewhere.example', `${ORIGIN}/@elsewhere.example`],
      ['javascript:alert(1)', `${ORIGIN}/javascript:alert(1)`],
      ['', `${ORIGIN}/`],
    ])(
      'loads a page of the application whatever it is handed: "%s" is %s',
      async (handed, loaded) => {
        const { session, location } = await aPageAt('/login');

        session.load(handed);

        expect(location.replace).toHaveBeenCalledWith(loaded);
        // The browser reads it as an address of the application, and of nowhere else.
        expect(new URL(location.replace.mock.calls[0]![0] as string).origin).toBe(ORIGIN);
      },
    );

    it('leaves a page of an account whose session has ended for the sign-in page, which is told where to come back to', async () => {
      const { session, location } = await aPageAt('/meal-plans', '?profile=0b1f');

      session.leave();

      expect(location.replace).toHaveBeenCalledWith(
        `${ORIGIN}/login?next=%2Fmeal-plans%3Fprofile%3D0b1f`,
      );
    });

    it('leaves the home page of the account for the plain sign-in page', async () => {
      const { session, location } = await aPageAt('/dashboard');

      session.leave();

      expect(location.replace).toHaveBeenCalledWith(`${ORIGIN}/login`);
    });

    it.each(['/login', '/', '/terms', '/admin', '/reset-password'])(
      'stays on %s, a page anybody can open: it has nothing of the account to lose',
      async (pathname) => {
        const { session, location } = await aPageAt(pathname, '?next=%2Fprofile');

        session.leave();

        expect(location.replace).not.toHaveBeenCalled();
      },
    );
  });
});
