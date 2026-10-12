// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { ACCOUNT_PAGES, HOME, isAccountPage, returnPath, signInPath } from './return-path';

describe('a page of an account', () => {
  it.each(ACCOUNT_PAGES)('is %s, what lies under it, and either with what it was asked with', (page) => {
    expect(isAccountPage(page)).toBe(true);
    expect(isAccountPage(`${page}/0b1f`)).toBe(true);
    expect(isAccountPage(`${page}?profile=0b1f`)).toBe(true);
  });

  it.each(['/', '/login', '/register', '/terms', '/admin', '/review', '/api/users/me', '/dashboards', '/settings.html', 'dashboard', ''])('is not %s', (path) => {
    expect(isAccountPage(path)).toBe(false);
  });
});

describe('the page a sign-in returns to', () => {
  it('is the page of the account that was asked for, with what it was asked with', () => {
    expect(returnPath('/meal-plans')).toBe('/meal-plans');
    expect(returnPath('/recipes/0b1f?from=plan&day=2')).toBe('/recipes/0b1f?from=plan&day=2');
  });

  it.each([null, undefined, ''])('is the home page when nothing was asked for (%s)', (asked) => {
    expect(returnPath(asked)).toBe(HOME);
  });

  it.each([
    ['another site', 'https://elsewhere.example/'],
    ['another site without a scheme', '//elsewhere.example/dashboard'],
    ['what a browser reads as another site', '/\\elsewhere.example'],
    ['the same, with a tab a browser drops', '/\t/elsewhere.example'],
    ['the same, with a line break a browser drops', '/\n/elsewhere.example'],
    ['a script', 'javascript:alert(1)'],
    ['a path that does not begin at the root', 'dashboard'],
    ['a page of the API', '/api/users/me'],
    ['a page anybody can open', '/terms'],
    ['the sign-in page', '/login?next=%2Fprofile'],
    ['the page to sign up at', '/register'],
    ['a page whose name only begins like one of the account', '/settingsx'],
    ['a way up and out of a page of the account', '/dashboard/../../api/users/me'],
    ['the same, written as a browser also reads it', '/dashboard/%2e%2e/%2E%2E/api/users/me'],
    ['the same, with backslashes', '/dashboard\\..\\..\\api\\users\\me'],
    ['the same, with a tab between the dots', '/settings/.\t./.\t./admin'],
    ['a way up to the landing page', '/settings/..'],
    ['an address no browser can read', 'http://['],
  ])('is the home page for %s', (_what, asked) => {
    expect(returnPath(asked)).toBe(HOME);
  });

  it('is the page a roundabout path comes to, written straight', () => {
    expect(returnPath('/settings/../profile?tab=1')).toBe('/profile?tab=1');
    expect(returnPath('/recipes/./0b1f#method')).toBe('/recipes/0b1f');
  });
});

describe('the sign-in page for a visitor who was on a page', () => {
  it('carries the page, so that signing in leads back to it', () => {
    expect(signInPath('/meal-plans?profile=0b1f')).toBe('/login?next=%2Fmeal-plans%3Fprofile%3D0b1f');
    expect(returnPath(new URLSearchParams(signInPath('/meal-plans?profile=0b1f').split('?')[1]).get('next'))).toBe('/meal-plans?profile=0b1f');
  });

  it('says nothing of the home page, where a sign-in leads anyway', () => {
    expect(signInPath(HOME)).toBe('/login');
  });

  it('says nothing of a page a sign-in would not lead to', () => {
    expect(signInPath('//elsewhere.example')).toBe('/login');
    expect(signInPath('/login?next=%2Fprofile')).toBe('/login');
    expect(signInPath('/terms')).toBe('/login');
  });
});
