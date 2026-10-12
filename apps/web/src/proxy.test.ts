// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from './proxy';

const asked = (path: string, cookie?: string): ReturnType<typeof proxy> =>
  proxy(new NextRequest(new URL(path, 'http://app.example.test'), cookie ? { headers: { cookie } } : undefined));

describe('a request for a page of a signed-in account', () => {
  it('goes on to the page when the browser holds a session', () => {
    const answer = asked('/meal-plans?profile=0b1f', 'NEXT_LOCALE=pl; diet_session=1');

    expect(answer.headers.get('x-middleware-next')).toBe('1');
    expect(answer.headers.get('location')).toBeNull();
  });

  it('is sent to the sign-in page, which is told the page that was asked for', () => {
    const answer = asked('/meal-plans?profile=0b1f');

    expect(answer.status).toBe(307);
    expect(answer.headers.get('location')).toBe('http://app.example.test/login?next=%2Fmeal-plans%3Fprofile%3D0b1f');
    expect(answer.headers.get('x-middleware-next')).toBeNull();
  });

  it('is sent to the plain sign-in page from the home page of the account', () => {
    expect(asked('/dashboard').headers.get('location')).toBe('http://app.example.test/login');
  });

  it.each(['diet_session=', 'diet_session=0', 'diet_session=true', 'diet_refresh=something', 'other_diet_session=1'])('is sent to sign in with the cookie "%s", which is not the marker of a session', (cookie) => {
    expect(asked('/settings', cookie).status).toBe(307);
  });

  it('is every page under the shell of an account: a page that is added there is guarded with it', () => {
    const pages = readdirSync(join(import.meta.dirname, 'app', '(app)'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `/${entry.name}/:path*`);

    expect([...config.matcher].sort()).toEqual(pages.sort());
  });
});
