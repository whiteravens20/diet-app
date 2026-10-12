// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PAGES } from './lib/return-path';
import { config, proxy } from './proxy';

const ORIGIN = 'http://app.example.test';
const asked = (path: string, headers: Record<string, string> = {}): ReturnType<typeof proxy> => proxy(new NextRequest(new URL(path, ORIGIN), { headers }));
const SIGNED_IN = { cookie: 'NEXT_LOCALE=pl; diet_session=1' };

/** What the proxy hands on to the page under a name: the framework carries a changed request header this way. */
const handedOn = (answer: ReturnType<typeof proxy>, name: string): string | null => answer.headers.get(`x-middleware-request-${name}`);
const nonceOf = (policy: string | null): string => /'nonce-([^']+)'/.exec(policy ?? '')?.[1] ?? '';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a request for a page of a signed-in account', () => {
  it('goes on to the page when the browser holds a session', () => {
    const answer = asked('/meal-plans?profile=0b1f', SIGNED_IN);

    expect(answer.headers.get('x-middleware-next')).toBe('1');
    expect(answer.headers.get('location')).toBeNull();
  });

  it('is sent to the sign-in page, which is told the page that was asked for', () => {
    const answer = asked('/meal-plans?profile=0b1f');

    expect(answer.status).toBe(307);
    expect(answer.headers.get('location')).toBe(`${ORIGIN}/login?next=%2Fmeal-plans%3Fprofile%3D0b1f`);
    expect(answer.headers.get('x-middleware-next')).toBeNull();
  });

  it('is sent to the plain sign-in page from the home page of the account', () => {
    expect(asked('/dashboard').headers.get('location')).toBe(`${ORIGIN}/login`);
  });

  it.each(['diet_session=', 'diet_session=0', 'diet_session=true', 'diet_refresh=something', 'other_diet_session=1'])('is sent to sign in with the cookie "%s", which is not the marker of a session', (cookie) => {
    expect(asked('/settings', { cookie }).status).toBe(307);
  });

  it.each(ACCOUNT_PAGES)('is guarded as %s, and as what lies under it', (page) => {
    expect(asked(page).status).toBe(307);
    expect(asked(`${page}/0b1f`).status).toBe(307);
    expect(asked(page, SIGNED_IN).headers.get('x-middleware-next')).toBe('1');
  });

  it('is a request for any page under the shell of an account: a page that is added there is guarded with it', () => {
    const pages = readdirSync(join(import.meta.dirname, 'app', '(app)'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `/${entry.name}`);

    expect([...ACCOUNT_PAGES].sort()).toEqual(pages.sort());
  });
});

describe('a page anybody can open', () => {
  it.each(['/', '/login', '/register', '/terms', '/admin', '/review', '/no-such-page'])('is %s: nobody is sent away from it', (path) => {
    expect(asked(path).headers.get('x-middleware-next')).toBe('1');
  });
});

describe('the content security policy of a page', () => {
  it('names a nonce, and the page is handed the same one to put on its scripts', () => {
    const answer = asked('/login');
    const policy = answer.headers.get('content-security-policy');

    expect(nonceOf(policy)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(policy).toContain(`script-src 'self' 'nonce-${nonceOf(policy)}' 'strict-dynamic' 'wasm-unsafe-eval'`);
    // The framework reads the nonce from the policy on the request; the layout reads it by name.
    expect(handedOn(answer, 'content-security-policy')).toBe(policy);
    expect(handedOn(answer, 'x-nonce')).toBe(nonceOf(policy));
    expect(answer.headers.get('content-security-policy-report-only')).toBeNull();
  });

  it('is made anew for every response', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => nonceOf(asked('/login').headers.get('content-security-policy'))));

    expect(nonces.size).toBe(50);
  });

  it('is not the visitor\'s to choose: what a request brings under the same names is written over', () => {
    const answer = asked('/login', { 'x-nonce': 'chosen-by-the-visitor', 'content-security-policy': "script-src 'nonce-chosen-by-the-visitor' *" });

    expect(handedOn(answer, 'x-nonce')).not.toBe('chosen-by-the-visitor');
    expect(handedOn(answer, 'content-security-policy')).not.toContain('chosen-by-the-visitor');
    expect(answer.headers.get('content-security-policy')).not.toContain('chosen-by-the-visitor');
  });

  it('goes with a page of an account as with any other', () => {
    expect(nonceOf(asked('/dashboard', SIGNED_IN).headers.get('content-security-policy'))).not.toBe('');
  });

  it('allows the frame of the Turnstile challenge only where the instance uses one', () => {
    expect(asked('/login').headers.get('content-security-policy')).toContain("frame-src 'none'");

    vi.stubEnv('TURNSTILE_ENABLED', 'true');

    expect(asked('/login').headers.get('content-security-policy')).toContain('frame-src https://challenges.cloudflare.com');
  });
});

describe('the headers that are for https alone', () => {
  const transport = (answer: ReturnType<typeof proxy>): (string | null)[] => [answer.headers.get('strict-transport-security'), answer.headers.get('reporting-endpoints')];

  it.each([undefined, 'http://localhost:3000', 'http://192.168.1.20:3000'])('are not sent by an instance at %s, and its policy upgrades no request', (address) => {
    if (address) vi.stubEnv('APP_URL', address);
    const [page, away] = [asked('/login'), asked('/dashboard')];

    expect(transport(page)).toEqual([null, null]);
    expect(transport(away)).toEqual([null, null]);
    expect(page.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');
  });

  it('are sent by an instance whose public address is https, with a page and with the way to the sign-in page', () => {
    vi.stubEnv('APP_URL', 'https://diet.example.test');
    const [page, away] = [asked('/login'), asked('/dashboard')];

    expect(transport(page)).toEqual(['max-age=63072000; includeSubDomains', 'csp="/api/csp-reports"']);
    expect(transport(away)).toEqual(['max-age=63072000; includeSubDomains', 'csp="/api/csp-reports"']);
    expect(page.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
    expect(page.headers.get('content-security-policy')).toContain('report-to csp');
  });
});

describe('what the proxy runs for', () => {
  const runsFor = (path: string): boolean => new RegExp(`^${config.matcher[0]}$`).test(path);

  it.each(['/', '/login', '/dashboard', '/recipes/0b1f', '/admin', '/terms', '/no-such-page', '/apiary'])('is the page %s', (path) => {
    expect(runsFor(path)).toBe(true);
  });

  it.each(['/api/users/me', '/api/csp-reports', '/_next/static/chunks/0a1b.js', '/_next/image', '/imagery/recipes.webp', '/fonts/Inter-Regular.ttf', '/icon.svg', '/favicon.ico'])(
    'is not %s, which is no page',
    (path) => {
      expect(runsFor(path)).toBe(false);
    },
  );
});
