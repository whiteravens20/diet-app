// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Who may ask each route.
 *
 * Every route the API has is asked for by somebody it is not for: with no
 * session at all, with the sessions of the other kinds where those belong,
 * and with the token of another kind put where the route reads its own. A
 * route for an account, for the administrator or for a reviewer refuses each
 * of them. The routes anybody may ask are named here, so that a route nobody
 * guarded shows as a route that is missing from the list.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRoutes, type Asks, type Route } from '../../scripts/contract/routes.js';
import { resetDatabase } from '../testing/database.js';
import { aReviewer, aUser, as, asAdmin } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

type Kind = Exclude<Asks, 'anyone'>;

/**
 * The routes anybody may ask: what leads to a session of each kind (a
 * browser's from an application's among them) and what ends one, what a page
 * needs before anybody signed in, the health of the instance, and the reports
 * a browser sends by itself.
 */
const FOR_ANYBODY = [
  'DELETE /api/admin/session',
  'GET /api/admin/session',
  'GET /api/admin/status',
  'GET /api/config',
  'GET /api/health',
  'GET /api/review/session',
  'GET /api/review/status',
  'POST /api/admin/session',
  'POST /api/auth/browser-code',
  'POST /api/auth/browser-sign-in',
  'POST /api/auth/browser-sign-in/account',
  'POST /api/auth/confirm-email-change',
  'POST /api/auth/login',
  'POST /api/auth/login/second-factor',
  'POST /api/auth/logout',
  'POST /api/auth/password-reset/confirm',
  'POST /api/auth/password-reset/request',
  'POST /api/auth/refresh',
  'POST /api/auth/register',
  'POST /api/auth/verify-email',
  'POST /api/csp-reports',
  'POST /api/review/auth',
  'POST /api/review/auth/logout',
];

/** What a route answers somebody who has no session of its kind, and somebody whose session of its kind does not count. */
const REFUSED: Record<Kind, { without: string; withAnother: string }> = {
  account: { without: 'UNAUTHORIZED', withAnother: 'UNAUTHORIZED' },
  administrator: { without: 'AUTH_REQUIRED', withAnother: 'INVALID_ADMIN_SESSION' },
  reviewer: { without: 'NO_REVIEWER_SESSION', withAnother: 'INVALID_REVIEWER_SESSION' },
};

const nameOf = (route: Route): string => `${route.method} ${route.path}`;

describe('who may ask a route', () => {
  let t: TestApp;
  let routes: Route[];
  /** The token of a session of each kind, and the headers such a session asks with. */
  let token: Record<Kind, string>;
  let session: Record<Kind, Record<string, string>>;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    routes = await readRoutes();
    const user = await aUser(t);
    const reviewer = await aReviewer(t);
    session = { account: as(user), administrator: asAdmin, reviewer };
    token = {
      account: user.accessToken,
      administrator: asAdmin.Cookie.slice(asAdmin.Cookie.indexOf('=') + 1),
      reviewer: reviewer.Cookie.slice(reviewer.Cookie.indexOf('=') + 1),
    };
  });

  afterAll(async () => {
    await t.close();
  });

  /** The headers a token is sent in to a route of a kind: where that kind of route reads its session. */
  const presented = (kind: Kind, value: string): Record<string, string> =>
    kind === 'account'
      ? { Authorization: `Bearer ${value}` }
      : {
          Cookie: `${kind === 'administrator' ? 'admin_session' : 'reviewer_session'}=${value}`,
          Origin: 'http://localhost:3000',
        };

  /** The sessions of several kinds in one request. */
  const together = (kinds: Kind[]): Record<string, string> => {
    const headers = kinds.map((kind) => session[kind]);
    const cookies = headers.flatMap((each) => (each.Cookie ? [each.Cookie] : []));
    return {
      ...Object.assign({}, ...headers),
      ...(cookies.length > 0 ? { Cookie: cookies.join('; ') } : {}),
    } as Record<string, string>;
  };

  /** How a route answers a request with these headers: its status and its code. Whatever the path names, the route's guard answers first. */
  const answered = async (route: Route, headers: Record<string, string>): Promise<string> => {
    const path = route.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const res = await t.http()[method](path).set(headers);
    return `${res.status} ${String((res.body as { error?: unknown }).error)}`;
  };

  const guarded = (): (Route & { asks: Kind })[] =>
    routes.filter((route): route is Route & { asks: Kind } => route.asks !== 'anyone');
  const others = (kind: Kind): Kind[] =>
    (['account', 'administrator', 'reviewer'] as const).filter((other) => other !== kind);

  it('lets anybody ask the routes named here, and no other', () => {
    expect(
      routes
        .filter((route) => route.asks === 'anyone')
        .map(nameOf)
        .sort(),
    ).toEqual(FOR_ANYBODY);
    expect(guarded().length).toBeGreaterThan(130);
  });

  it('refuses a request without a session on every route that asks for one', async () => {
    const wrong: string[] = [];
    for (const route of guarded()) {
      const got = await answered(route, {});
      if (got !== `401 ${REFUSED[route.asks].without}`) wrong.push(`${nameOf(route)}: ${got}`);
    }

    expect(wrong).toEqual([]);
  });

  it('refuses the sessions of the other kinds, sent as those kinds send them', async () => {
    const wrong: string[] = [];
    for (const route of guarded()) {
      const got = await answered(route, together(others(route.asks)));
      if (got !== `401 ${REFUSED[route.asks].without}`) wrong.push(`${nameOf(route)}: ${got}`);
    }

    expect(wrong).toEqual([]);
  });

  it('refuses the token of another kind of session put where the route reads its own', async () => {
    const wrong: string[] = [];
    for (const route of guarded()) {
      for (const other of others(route.asks)) {
        const got = await answered(route, presented(route.asks, token[other]));
        if (got !== `401 ${REFUSED[route.asks].withAnother}`)
          wrong.push(`${nameOf(route)} with the token of ${other}: ${got}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('answers each of them when its own kind of session asks, so that the refusals above say something', async () => {
    await t.http().get('/api/users/me').set(session.account).expect(200);
    await t.http().get('/api/admin/stats').set(session.administrator).expect(200);
    await t
      .http()
      .get('/api/review/drafts/recipes')
      .query({ locale: 'pl' })
      .set(session.reviewer)
      .expect(200);
  });
});
