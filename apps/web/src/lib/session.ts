// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The session of this browser.
 *
 * The refresh token is in a cookie the API set, which no script can read. The
 * access token is here, in the memory of the page, and nowhere else: closing
 * the page forgets it, and a page that is loaded gets a new one with one
 * request (`refresh`). A second cookie that holds no secret, the marker, says
 * whether there is a session to refresh at all.
 *
 * Tabs share one session. Only one of them refreshes at a time (the Web
 * Locks API), and what it gets it tells the others over a broadcast channel,
 * as it tells them when the session is signed out of.
 */
import type { AuthResponse } from '@diet-app/shared';
import { signInPath } from './return-path';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const MARKER_COOKIE = 'diet_session';
const CHANNEL = 'diet-app.session';
const LOCK = 'diet-app.session.refresh';

type Message = { type: 'token'; accessToken: string; sessionId: string } | { type: 'signed-out' };

let accessToken: string | null = null;
let sessionId: string | null = null;
let refreshing: Promise<boolean> | null = null;
/** The last try at a new access token got no answer about the session: the server was busy, away, or would not take the request. */
let unreachable = false;
const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((listener) => listener());

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
channel?.addEventListener('message', (event: MessageEvent<Message>) => {
  if (event.data.type === 'token') {
    accessToken = event.data.accessToken;
    sessionId = event.data.sessionId;
    changed();
  } else {
    forgotten();
    session.leave();
  }
});

// A version before this one kept both tokens where every script of the page
// could read them. Whatever it left there is removed.
if (typeof localStorage !== 'undefined') {
  localStorage.removeItem('diet-app.access');
  localStorage.removeItem('diet-app.refresh');
}

function forgotten(): void {
  accessToken = null;
  sessionId = null;
  unreachable = false;
  // The marker is ours to drop; the refresh cookie is the API's, and is dead with the session.
  if (typeof document !== 'undefined') document.cookie = `${MARKER_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`;
  changed();
}

function adopt(answer: AuthResponse): void {
  accessToken = answer.tokens.accessToken;
  sessionId = answer.sessionId;
  unreachable = false;
  channel?.postMessage({ type: 'token', accessToken, sessionId } satisfies Message);
  changed();
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A request that acts on the session cookie. It is finished by the browser
 * even when the page that sent it is gone (`keepalive`): the answer to a
 * refresh holds the next cookie, and a page that is loaded again in that
 * moment would otherwise go on with a cookie the server has used up, and
 * lose the session.
 */
const onTheCookie = (path: string): Promise<Response> =>
  fetch(`${API_URL}/api/auth/${path}`, { method: 'POST', credentials: API_URL ? 'include' : 'same-origin', keepalive: true });

/** How long to wait before asking again after another request used the cookie: its answer is still on its way. */
const AFTER_ANOTHER_REQUEST_MS = [300, 700, 1500];

/** One turn at getting the next access token. True when the session goes on with a token to use. */
async function refreshOnce(before: string | null): Promise<boolean> {
  for (let attempt = 0; attempt <= AFTER_ANOTHER_REQUEST_MS.length; attempt += 1) {
    // Another tab refreshed while this one waited its turn, and said so.
    if (accessToken && accessToken !== before) return true;
    let res: Response;
    try {
      res = await onTheCookie('refresh');
    } catch {
      return notReached();
    }
    if (res.ok) {
      adopt((await res.json()) as AuthResponse);
      return true;
    }
    // Another request of this browser used the cookie a moment ago: a tab, or
    // the page this one was before it was loaded again. What that request
    // was given is on its way: to this page from the tab, or into the cookie.
    if (res.status === 409 && attempt < AFTER_ANOTHER_REQUEST_MS.length) {
      await wait(AFTER_ANOTHER_REQUEST_MS[attempt]!);
      continue;
    }
    // Only a refused session ends it. "Too many requests" or a server that
    // is down says nothing about the session: it is kept, and the next
    // request tries again.
    if (res.status !== 401) return notReached();
    forgotten();
    channel?.postMessage({ type: 'signed-out' } satisfies Message);
    session.leave();
    return false;
  }
  return Boolean(accessToken && accessToken !== before) || notReached();
}

/** No answer about the session this time: it stays, and whoever watches is told that it could not be reached. */
function notReached(): false {
  unreachable = true;
  changed();
  return false;
}

export const session = {
  /** The access token to send with a request, when the page has one. */
  get accessToken(): string | null {
    return accessToken;
  },

  /**
   * True when the last try at a new access token said nothing about the
   * session: it is still the browser's, and it could not be reached. It
   * stays so until a try gets through, or the session ends.
   */
  get unreachable(): boolean {
    return unreachable;
  },

  /** Which of the account's sessions this is, once the page has a token. */
  get id(): string | null {
    return sessionId;
  },

  /** True when the browser holds a session, as far as a script can tell: by the marker cookie. */
  exists(): boolean {
    return typeof document !== 'undefined' && /(?:^|;\s*)diet_session=1(?:;|$)/.test(document.cookie);
  },

  /** The session that an answer to a sign-in or a registration began. */
  begin(answer: AuthResponse): void {
    adopt(answer);
  },

  /**
   * Get the next access token. Whoever asks while a request is on its way
   * waits for that one, and only one tab asks at a time.
   */
  refresh(): Promise<boolean> {
    if (refreshing) return refreshing;
    const before = accessToken;
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    const run = (): Promise<boolean> => refreshOnce(before);
    refreshing = (locks ? (locks.request(LOCK, run) as Promise<boolean>) : run()).finally(() => {
      refreshing = null;
    });
    return refreshing;
  },

  /** The session has ended on the server (a new address): forget it here and in the other tabs. */
  forget(): void {
    forgotten();
    channel?.postMessage({ type: 'signed-out' } satisfies Message);
  },

  /**
   * Load a page of the application anew. An account is entered and left this
   * way, never by a move inside the page: what the page held in memory
   * (answers of the API, pages the router kept) belongs to whoever was
   * signed in then, and goes with it.
   */
  load(path: string): void {
    window.location.assign(path);
  },

  /**
   * The session has ended by the reader's own doing (signed out, a new
   * password, the account deleted): forget it here and in the other tabs,
   * and go on at `to`.
   */
  end(to: string): void {
    session.forget();
    session.load(to);
  },

  /** Sign out: the session ends on the server, here and in the other tabs, and the sign-in page is next. */
  async signOut(): Promise<void> {
    await onTheCookie('logout').catch(() => undefined);
    session.end('/login');
  },

  /**
   * Where a page goes when its session has ended under it: the sign-in
   * page, which brings the reader back afterwards. A hard navigation, so
   * that nothing a signed-in page had loaded stays on screen.
   */
  leave(): void {
    if (typeof window === 'undefined' || window.location.pathname.startsWith('/login')) return;
    window.location.replace(signInPath(`${window.location.pathname}${window.location.search}`));
  },

  /** Be told when the session begins, goes on with another token, or ends. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
