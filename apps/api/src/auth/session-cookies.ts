// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ForbiddenException } from '@nestjs/common';
import type { AuthResponse } from '@diet-app/shared';

/**
 * How a browser holds its session. It asks for this at sign-in with the
 * header `X-Session-Transport: cookie`. Its refresh token then lives in a
 * cookie that no script can read and that is sent to the routes of this
 * controller alone, and is never part of an answer: a script that got into
 * the page finds nothing to carry off that outlasts the page. A client that
 * keeps its own tokens (an app) does not ask, and gets them in the answer.
 */
const SESSION_TRANSPORT_HEADER = 'x-session-transport';

/** The refresh token of a browser's session. */
export const REFRESH_COOKIE = 'diet_refresh';

/**
 * Says that there is a session and nothing else: scripts and the route guard
 * of the web application read it to know whether to try a refresh at all.
 */
const SESSION_MARKER_COOKIE = 'diet_session';

const REFRESH_PATH = '/api/auth';

export function asksForCookies(headers: Record<string, string | string[] | undefined>): boolean {
  return headers[SESSION_TRANSPORT_HEADER] === 'cookie';
}

function cookie(name: string, value: string, maxAgeSeconds: number, path: string, appUrl: string, httpOnly: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    ...(httpOnly ? ['HttpOnly'] : []),
    // Never sent along with a request that another site caused.
    'SameSite=Strict',
    ...(appUrl.startsWith('https://') ? ['Secure'] : []),
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** The cookies of a session that goes on: both last as long as the refresh token does. */
export function sessionCookies(tokens: { refreshToken?: string; refreshExpiresIn: number }, appUrl: string): string[] {
  return [
    cookie(REFRESH_COOKIE, tokens.refreshToken ?? '', tokens.refreshExpiresIn, REFRESH_PATH, appUrl, true),
    cookie(SESSION_MARKER_COOKIE, '1', tokens.refreshExpiresIn, '/', appUrl, false),
  ];
}

/** The cookies of a session that has ended: both are taken away. */
export function noSessionCookies(appUrl: string): string[] {
  return [cookie(REFRESH_COOKIE, '', 0, REFRESH_PATH, appUrl, true), cookie(SESSION_MARKER_COOKIE, '', 0, '/', appUrl, false)];
}

/** An answer for a browser: the same, without the refresh token that went into the cookie. */
export function withoutRefreshToken(answer: AuthResponse): AuthResponse {
  const { accessToken, expiresIn, refreshExpiresIn } = answer.tokens;
  return { ...answer, tokens: { accessToken, expiresIn, refreshExpiresIn } };
}

/**
 * A request that acts on the cookie must come from the application's own
 * pages. The cookie is not sent with requests another site causes, and this
 * holds where a browser does not keep to that: the request says where it
 * comes from, and it has to be here.
 */
export function assertFromTheApplication(origin: string | undefined, appUrl: string): void {
  if (origin !== new URL(appUrl).origin) {
    throw new ForbiddenException({ error: 'ORIGIN_NOT_ALLOWED', message: 'This request has to come from the application itself.' });
  }
}
