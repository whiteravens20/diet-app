// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The one way the web application asks the API for anything.
 *
 * Three identities use it: an account (`api.ts`), the administrator
 * (`admin-api.ts`) and a reviewer (`review-api.ts`). They differ in the part
 * of the API they speak to and in what proves who asks, which each of them
 * hands in as `WhoAsks`. Everything else is the same for all three and lives
 * here: the headers every request carries, what a refusal is turned into,
 * and what an answer without a body means.
 */
import { DEFAULT_LOCALE, LOCALE_COOKIE } from './locale';

// Empty by default: requests go to a relative `/api/*` path on the web app's
// own origin, which Next.js proxies to the backend (see next.config.ts). Set
// NEXT_PUBLIC_API_URL only to bypass the proxy and call the API cross-origin.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

/**
 * The cookies of a session go with requests to the application's own address
 * by themselves; an API at another address has to be told.
 */
const WITH_COOKIES: RequestCredentials = API_URL ? 'include' : 'same-origin';

/** The address of a path of the API, as `fetch` takes it. */
const apiUrl = (path: string): string => `${API_URL}/api${path}`;

export interface ApiErrorIssue {
  path: string;
  message: string;
}

/** A request that failed: refused by the API, or never answered. */
export class ApiClientError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never reached the server. */
    public readonly status: number,
    /** The API's code for the refusal; `NETWORK` when nothing answered, `ERROR` when the answer named none. */
    public readonly code: string,
    /** What the API said, in English: for a log, and for a code this version has no words for. */
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
export function waitOf(
  status: number,
  retryAfterSeconds: number | undefined,
): { unit: 'seconds' | 'minutes'; count: number } | null {
  if (status !== 429 || retryAfterSeconds === undefined) return null;
  return retryAfterSeconds > 90
    ? { unit: 'minutes', count: Math.ceil(retryAfterSeconds / 60) }
    : { unit: 'seconds', count: Math.ceil(retryAfterSeconds) };
}

/** `Retry-After` in seconds, as the API writes it; a date or nothing at all is no number. */
function retryAfterOf(res: Response): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return seconds > 0 ? seconds : undefined;
}

/**
 * The language the application is shown in. The cookie is the source of
 * truth (the language switcher writes it, and a first visit does); it is read
 * at every request, so a change in one tab is picked up by the next request
 * of another.
 */
function appLocale(): string {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : DEFAULT_LOCALE;
}

/**
 * The day it is for the user, as `2026-03-01`: by the clock and the time zone
 * of the browser, not in UTC, where late in the evening it is already
 * tomorrow or still yesterday.
 */
export function localDate(now = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** What proves who asks: the part in which the three identities differ. */
export interface WhoAsks {
  /** Put what proves it into the request, before it is sent. A cookie needs nothing here: the browser sends it. */
  sign?(headers: Headers): Promise<void>;
  /**
   * Told that the API answered 401, with the code of the refusal when it
   * named one. True when the proof was renewed and the request is worth
   * sending once more.
   */
  renewed?(code: string | undefined): Promise<boolean>;
}

export interface ApiClient {
  /** Any request, as `fetch` takes it; the other methods are this one with the method and the body filled in. */
  request<T>(path: string, init?: RequestInit): Promise<T>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string, body?: unknown): Promise<T>;
  /** An answer that is a file and not JSON. */
  download(path: string): Promise<Blob>;
}

interface Refusal {
  error?: string;
  message?: string;
  issues?: ApiErrorIssue[];
  details?: Record<string, unknown>;
}

const json = (body: unknown): string | undefined =>
  body === undefined || body === null ? undefined : JSON.stringify(body);

/** A client for the part of the API under `base` (`''`, `/admin`, `/review`), asking as `who`. */
export function apiClient(base: string, who: WhoAsks = {}): ApiClient {
  /** Send a request and hand back the answer when it is no refusal; a refusal is thrown. */
  async function answerTo(path: string, init: RequestInit, again: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    // Which plan is under way and which days have passed goes by the user's day.
    headers.set('x-client-date', localDate());
    // The language the API words its answers in: the application's, not the browser's.
    if (!headers.has('accept-language')) headers.set('accept-language', appLocale());
    await who.sign?.(headers);

    let res: Response;
    try {
      res = await fetch(apiUrl(`${base}${path}`), { ...init, headers, credentials: WITH_COOKIES });
    } catch {
      // fetch only rejects on a network-level failure (server down, DNS, CORS).
      throw new ApiClientError(
        0,
        'NETWORK',
        'Cannot reach the server. Check your connection and that the API is running.',
      );
    }
    if (res.ok) return res;

    const body = (await res.json().catch(() => ({}))) as Refusal;
    if (res.status === 401 && again && who.renewed && (await who.renewed(body.error)))
      return answerTo(path, init, false);
    throw new ApiClientError(
      res.status,
      body.error ?? 'ERROR',
      body.message ?? res.statusText,
      body.issues,
      retryAfterOf(res),
      body.details,
    );
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await answerTo(path, init, true);
    // An answer without a body (204, 202, or anything that wrote no JSON) is
    // nothing, not a failure to read one.
    if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
    const text = await res.text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  return {
    request,
    get: (path) => request(path),
    post: (path, body, headers) => request(path, { method: 'POST', body: json(body), headers }),
    put: (path, body) => request(path, { method: 'PUT', body: json(body) }),
    patch: (path, body) => request(path, { method: 'PATCH', body: json(body) }),
    delete: (path, body) => request(path, { method: 'DELETE', body: json(body) }),
    download: async (path) => (await answerTo(path, {}, true)).blob(),
  };
}
