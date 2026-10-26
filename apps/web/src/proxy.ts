// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { NextResponse, type NextRequest } from 'next/server';
import { isAccountPage, signInPath } from './lib/return-path';
import { contentSecurityPolicy, TRANSPORT_HEADERS } from './lib/security-headers';

/** The cookie the API sets beside a session's refresh token; it holds no secret, only that there is a session. */
const SESSION_MARKER = 'diet_session';

/** A value for one response, which nobody can guess: 128 random bits. */
function aNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

/** The two settings of the instance the web server is told (see the `web` service of the Compose files): none of them is a secret. */
function instance(): { https: boolean; turnstile: boolean } {
  return {
    https: (process.env.APP_URL ?? '').startsWith('https://'),
    turnstile: process.env.TURNSTILE_ENABLED === 'true',
  };
}

/**
 * Runs before a page is rendered, for every page.
 *
 * A visitor whose browser holds no session gets no page of an account, and
 * no shell that would ask the API for what it will refuse: they are sent to
 * the sign-in page, which knows where they wanted to go. The marker says
 * only that the browser has a session, not that it is still good: that is
 * the API's to say, at the first request of the page.
 *
 * Every page gets a content security policy with a nonce of its own. The
 * policy goes onto the request as well: the framework reads the nonce from
 * there and puts it on the scripts it writes into the page.
 */
export function proxy(request: NextRequest): NextResponse {
  const { https, turnstile } = instance();
  const { pathname, search } = request.nextUrl;
  const answer = (response: NextResponse): NextResponse => {
    if (https) for (const { key, value } of TRANSPORT_HEADERS) response.headers.set(key, value);
    return response;
  };

  if (isAccountPage(pathname) && request.cookies.get(SESSION_MARKER)?.value !== '1') {
    return answer(
      NextResponse.redirect(new URL(signInPath(`${pathname}${search}`), request.nextUrl)),
    );
  }

  const nonce = aNonce();
  const policy = contentSecurityPolicy({ nonce, https, turnstile });
  // Whatever a client sent under these names is written over.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return answer(response);
}

export const config = {
  // Every path but the API (the web server only passes it on), the files of
  // the build and what `public/` holds: none of those is a page.
  matcher: [
    '/((?!api/|_next/static/|_next/image|fonts/|imagery/|icon.svg|icon-192.png|icon-512.png|icon-maskable-512.png|apple-touch-icon.png|favicon.ico).*)',
  ],
};
