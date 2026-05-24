/**
 * Typed API client. Every payload is a type from `@diet-app/shared`, so the
 * client and server cannot drift. Tokens live in localStorage; a 401 triggers a
 * one-shot refresh.
 */
import type { AuthResponse } from '@diet-app/shared';

// Empty by default: requests go to a relative `/api/*` path on the web app's
// own origin, which Next.js proxies to the backend (see next.config.ts). Set
// NEXT_PUBLIC_API_URL only to bypass the proxy and call the API cross-origin.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const ACCESS_KEY = 'diet-app.access';
const REFRESH_KEY = 'diet-app.refresh';

export const tokenStore = {
  get access(): string | null {
    return typeof window === 'undefined' ? null : localStorage.getItem(ACCESS_KEY);
  },
  get refresh(): string | null {
    return typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_KEY);
  },
  set(tokens: { accessToken: string; refreshToken: string }): void {
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

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
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  const access = tokenStore.access;
  if (access) headers.set('authorization', `Bearer ${access}`);

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, { ...init, headers });
  } catch {
    // fetch only rejects on a network-level failure (server down, DNS, CORS).
    throw new ApiClientError(
      0,
      'NETWORK',
      'Cannot reach the server. Check your connection and that the API is running.',
    );
  }

  if (res.status === 401 && retry && tokenStore.refresh) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, init, false);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      issues?: ApiErrorIssue[];
    };
    // A validation failure carries per-field issues — surface those instead of
    // the generic envelope message.
    const message =
      body.issues && body.issues.length > 0
        ? body.issues.map((i) => i.message).join(' ')
        : (body.message ?? res.statusText);
    throw new ApiClientError(res.status, body.error ?? 'ERROR', message, body.issues);
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

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokenStore.refresh }),
    });
    if (!res.ok) {
      tokenStore.clear();
      return false;
    }
    const data = (await res.json()) as AuthResponse;
    tokenStore.set(data.tokens);
    return true;
  } catch {
    return false;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
