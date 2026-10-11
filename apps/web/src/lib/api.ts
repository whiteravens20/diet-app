// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Typed API client. Every payload is a type from `@diet-app/shared`, so the
 * client and server cannot drift. The access token comes from the browser's
 * session (`session.ts`): a page that was just loaded gets one before its
 * first request, and a 401 gets the next one, once.
 */
import { session } from './session';

// Empty by default: requests go to a relative `/api/*` path on the web app's
// own origin, which Next.js proxies to the backend (see next.config.ts). Set
// NEXT_PUBLIC_API_URL only to bypass the proxy and call the API cross-origin.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

/**
 * Sent with a sign-in and a registration: this client is a browser, and
 * wants its refresh token in a cookie no script can read, not in the answer.
 */
export const COOKIE_SESSION = { 'x-session-transport': 'cookie' };

export interface ApiErrorIssue {
  path: string;
  message: string;
}

export class ApiClientError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never reached the server. */
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Field-level validation problems, when the API reported any. */
    public readonly issues?: ApiErrorIssue[],
    /** How long the server asks to wait before the next try, in seconds, when it said so. */
    public readonly retryAfterSeconds?: number,
    /** What the refusal was about, in fields that depend on its code. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * How long to wait after a request that was held up, as the server said, or
 * null when it was not held up or did not say. Sign-in is held up for as long
 * as a quarter of an hour, the administrator's for half a minute at first:
 * "try again in a moment" would be wrong for either. Seconds up to a minute
 * and a half, whole minutes beyond.
 */
export function waitOf(status: number, retryAfterSeconds: number | undefined): { unit: 'seconds' | 'minutes'; count: number } | null {
  if (status !== 429 || retryAfterSeconds === undefined) return null;
  return retryAfterSeconds > 90
    ? { unit: 'minutes', count: Math.ceil(retryAfterSeconds / 60) }
    : { unit: 'seconds', count: Math.ceil(retryAfterSeconds) };
}

/**
 * The refusals that are about the access token: it ran out, or the server no
 * longer takes its session for open. Any other 401 is about what the request
 * said (a wrong current password, a wrong code), and asking again with a new
 * token would only try the same thing a second time.
 */
const ACCESS_TOKEN_REFUSALS = new Set(['UNAUTHORIZED', 'INVALID_ACCESS_TOKEN']);

interface Refusal {
  error?: string;
  message?: string;
  issues?: ApiErrorIssue[];
  details?: Record<string, unknown>;
}

/** `Retry-After` in seconds, as the API writes it; a date or nothing at all is no number. */
export function retryAfterOf(res: Response): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return seconds > 0 ? seconds : undefined;
}

/** Locale module-state so every fetch carries the right Accept-Language. The
 *  cookie is the source of truth (set by the language switcher + middleware
 *  fallback); we read it once per request so tab-level locale changes are
 *  picked up without re-importing the API client. */
function currentLocale(): string {
  if (typeof document === 'undefined') return 'en';
  const match = document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : 'en';
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  // Tell the API which locale to serve translated text in. The API resolves
  // this header in `RequestLocale` decorator; absent/unsupported → 'en'.
  if (!headers.has('accept-language')) headers.set('accept-language', currentLocale());
  // A page that was just loaded holds no access token yet: where the browser
  // has a session, it gets one first.
  if (!session.accessToken && session.exists()) await session.refresh();
  const access = session.accessToken;
  if (access) headers.set('authorization', `Bearer ${access}`);

  let res: Response;
  try {
    // The cookies of the session go with requests to the application's own
    // address by themselves; an API at another address has to be told.
    res = await fetch(`${API_URL}/api${path}`, { ...init, headers, credentials: API_URL ? 'include' : 'same-origin' });
  } catch {
    // fetch only rejects on a network-level failure (server down, DNS, CORS).
    throw new ApiClientError(
      0,
      'NETWORK',
      'Cannot reach the server. Check your connection and that the API is running.',
    );
  }

  const body: Refusal = res.ok ? {} : ((await res.json().catch(() => ({}))) as Refusal);

  // A refusal that does not say what it is about is taken to be about the token.
  if (res.status === 401 && retry && session.exists() && (body.error === undefined || ACCESS_TOKEN_REFUSALS.has(body.error))) {
    if (await session.refresh()) return request<T>(path, init, false);
  }

  if (!res.ok) {
    // A validation failure carries per-field issues — surface those instead of
    // the generic envelope message.
    const message =
      body.issues && body.issues.length > 0
        ? body.issues.map((i) => i.message).join(' ')
        : (body.message ?? res.statusText);
    throw new ApiClientError(res.status, body.error ?? 'ERROR', message, body.issues, retryAfterOf(res), body.details);
  }
  // Treat any 2xx with no body (204 No Content, 202 Accepted with empty body,
  // or anything that didn't actually write JSON) as undefined — calling
  // res.json() on an empty body throws and would surface as a misleading
  // "something went wrong" to the user.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }
  const text = await res.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, headers }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
};
