// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The API client of an account. Every payload is a type from
 * `@diet-app/shared`, so the client and server cannot drift. The access token
 * comes from the browser's session (`session.ts`): a page that was just
 * loaded gets one before its first request, and a 401 gets the next one, once.
 */
import { apiClient, type ApiClient } from './http';
import { offline } from './offline';
import { session } from './session';

/**
 * Sent with a sign-in and a registration: this client is a browser, and
 * wants its refresh token in a cookie no script can read, not in the answer.
 */
export const COOKIE_SESSION = { 'x-session-transport': 'cookie' };

/**
 * The refusals that are about the access token: it ran out, or the server no
 * longer takes its session for open. Any other 401 is about what the request
 * said (a wrong current password, a wrong code), and asking again with a new
 * token would only try the same thing a second time.
 */
const ACCESS_TOKEN_REFUSALS = new Set(['UNAUTHORIZED', 'INVALID_ACCESS_TOKEN']);

const client = apiClient('', {
  async sign(headers) {
    // A page that was just loaded holds no access token yet: where the
    // browser has a session, it gets one first.
    if (!session.accessToken && session.exists()) await session.refresh();
    const access = session.accessToken;
    if (access) headers.set('authorization', `Bearer ${access}`);
  },
  async renewed(code) {
    // A refusal that does not say what it is about is taken to be about the token.
    if (!session.exists() || (code !== undefined && !ACCESS_TOKEN_REFUSALS.has(code))) return false;
    return session.refresh();
  },
});

/**
 * The client of an account. What it reads of plans and shopping lists is
 * kept in the browser as it is read, and answered from there when the server
 * cannot be reached (`offline.ts`): a list can then still be read in a shop
 * without a signal. Everything that changes something is asked of the server
 * alone.
 */
export const api: ApiClient = {
  ...client,
  get: <Answer>(path: string) => offline.through<Answer>(path, () => client.get<Answer>(path)),
};
