// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { NextResponse, type NextRequest } from 'next/server';
import { signInPath } from './lib/return-path';

/** The cookie the API sets beside a session's refresh token; it holds no secret, only that there is a session. */
const SESSION_MARKER = 'diet_session';

/**
 * Runs before a page of a signed-in account is rendered. A visitor whose
 * browser holds no session gets no shell and no page that would ask the API
 * for what it will refuse: they are sent to the sign-in page, which knows
 * where they wanted to go.
 *
 * The marker says only that the browser has a session, not that it is still
 * good: that is the API's to say, at the first request of the page.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.get(SESSION_MARKER)?.value === '1') return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(new URL(signInPath(`${pathname}${search}`), request.nextUrl));
}

export const config = {
  matcher: ['/dashboard/:path*', '/profile/:path*', '/recipes/:path*', '/meal-plans/:path*', '/shopping-lists/:path*', '/inventory/:path*', '/settings/:path*'],
};
