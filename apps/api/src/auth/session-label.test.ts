// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { sessionLabel } from './session-label.js';

describe('what a session is called in the list of an account\'s sessions', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 'Safari on iOS'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/90.0.0.0', 'Opera on Android'],
  ])('names the browser and the system of %s', (userAgent, label) => {
    expect(sessionLabel(userAgent)).toBe(label);
  });

  it('names a client that is no browser by what it calls itself', () => {
    expect(sessionLabel('DietApp-Android/1.4.0 (Pixel 9; Android 15)')).toBe('DietApp-Android on Android');
    expect(sessionLabel('curl/8.14.1')).toBe('curl');
  });

  it('is nothing where the request did not say, or said nothing that can be shown', () => {
    expect(sessionLabel(undefined)).toBeNull();
    expect(sessionLabel('')).toBeNull();
    expect(sessionLabel('<script>alert(1)</script>')).toBeNull();
  });

  it('keeps nothing of the request but the two names', () => {
    const label = sessionLabel('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0 secret-build-7f3a')!;

    expect(label).toBe('Firefox on Linux');
    // A name of forty characters is the longest that is taken for one.
    expect(sessionLabel(`${'A'.repeat(40)}/1.0`)).toHaveLength(40);
    expect(sessionLabel(`${'A'.repeat(41)}/1.0`)).toBeNull();
  });
});
