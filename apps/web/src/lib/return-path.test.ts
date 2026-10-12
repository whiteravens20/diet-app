// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { HOME, returnPath, signInPath } from './return-path';

describe('the page a sign-in returns to', () => {
  it('is the page that was asked for, with what it was asked with', () => {
    expect(returnPath('/meal-plans')).toBe('/meal-plans');
    expect(returnPath('/recipes/0b1f?from=plan&day=2')).toBe('/recipes/0b1f?from=plan&day=2');
  });

  it.each([null, undefined, ''])('is the home page when nothing was asked for (%s)', (asked) => {
    expect(returnPath(asked)).toBe(HOME);
  });

  it.each([
    ['another site', 'https://elsewhere.example/'],
    ['another site without a scheme', '//elsewhere.example/path'],
    ['what a browser reads as another site', '/\\elsewhere.example'],
    ['the same, with a tab a browser drops', '/\t/elsewhere.example'],
    ['the same, with a line break a browser drops', '/\n/elsewhere.example'],
    ['a script', 'javascript:alert(1)'],
    ['a path that does not begin at the root', 'dashboard'],
    ['a path with a control character', '/meal-plans\u0000'],
  ])('is the home page for %s', (_what, asked) => {
    expect(returnPath(asked)).toBe(HOME);
  });

  it.each(['/login', '/login?next=%2Fprofile', '/login/', '/register', '/register?plan=1'])('is never a page to sign in or up at (%s)', (asked) => {
    expect(returnPath(asked)).toBe(HOME);
  });

  it('is a page whose name only begins like a sign-in page', () => {
    expect(returnPath('/logins')).toBe('/logins');
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
  });
});
