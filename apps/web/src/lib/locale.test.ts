// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { isSupportedLocale, pickFromBrowserLanguage } from './locale';

describe('the language of the application on a first visit', () => {
  it("is the browser's, where the application has it, whatever its region", () => {
    expect(pickFromBrowserLanguage('pl-PL')).toBe('pl');
    expect(pickFromBrowserLanguage('pl')).toBe('pl');
    expect(pickFromBrowserLanguage('EN-gb')).toBe('en');
  });

  it("is none of the browser's where the application does not have it, or the browser names none", () => {
    expect(pickFromBrowserLanguage('de-DE')).toBeNull();
    expect(pickFromBrowserLanguage('')).toBeNull();
    expect(pickFromBrowserLanguage(null)).toBeNull();
    expect(pickFromBrowserLanguage(undefined)).toBeNull();
  });

  it('is taken from a cookie only where the cookie names a language the application has', () => {
    expect(isSupportedLocale('pl')).toBe(true);
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('pl-PL')).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });
});
