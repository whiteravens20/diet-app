// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { CSP_REPORT_ONLY, SECURITY_HEADERS } from './security-headers';

describe('web security headers (WI-F1)', () => {
  const byKey = new Map(SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));

  it('declares every required security header', () => {
    for (const key of [
      'strict-transport-security',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'permissions-policy',
    ]) {
      expect(byKey.has(key), `missing ${key}`).toBe(true);
    }
  });

  it('sets nosniff, DENY framing and a sane referrer policy', () => {
    expect(byKey.get('x-content-type-options')).toBe('nosniff');
    expect(byKey.get('x-frame-options')).toBe('DENY');
    expect(byKey.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('sends HSTS without preload (self-host friendly)', () => {
    const hsts = byKey.get('strict-transport-security') ?? '';
    expect(hsts).toMatch(/max-age=\d+/);
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).not.toContain('preload');
  });

  it('ships CSP in Report-Only mode with a strict script-src and locked frame-ancestors', () => {
    // Until the CSP is browser-validated and promoted, it must be Report-Only.
    expect(byKey.has('content-security-policy')).toBe(false);
    expect(byKey.has('content-security-policy-report-only')).toBe(true);
    expect(CSP_REPORT_ONLY).toContain("default-src 'self'");
    expect(CSP_REPORT_ONLY).toContain("script-src 'self'");
    expect(CSP_REPORT_ONLY).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(CSP_REPORT_ONLY).toContain("frame-ancestors 'none'");
    expect(CSP_REPORT_ONLY).toContain("object-src 'none'");
  });
});
