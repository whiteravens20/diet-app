// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { describeTrustProxy, parseTrustProxy } from './trust-proxy.js';

describe('TRUST_PROXY', () => {
  it.each([undefined, '', '  ', 'false', 'off', '0', 'FALSE'])('is off for %j', (raw) => {
    expect(parseTrustProxy(raw)).toBe(false);
  });

  it.each([
    ['1', 1],
    ['2', 2],
    [' 3 ', 3],
  ])('reads %j as a number of proxies', (raw, hops) => {
    expect(parseTrustProxy(raw)).toBe(hops);
  });

  it('reads a list of addresses, networks and named ranges', () => {
    expect(parseTrustProxy('10.0.0.0/8, 172.18.0.5,fd00::/8, loopback')).toEqual(['10.0.0.0/8', '172.18.0.5', 'fd00::/8', 'loopback']);
  });

  it('refuses "true": it would believe an address any client writes', () => {
    expect(() => parseTrustProxy('true')).toThrow(/any client writes/);
  });

  it.each(['yes', 'traefik', '10.0.0.0/33', '10.0.0/8', 'fd00::/129', '10.0.0.1/8/8', '11'])('refuses %j and says why', (raw) => {
    expect(() => parseTrustProxy(raw)).toThrow();
  });

  it('says in one line whose word is taken', () => {
    expect(describeTrustProxy(false)).toMatch(/TRUST_PROXY is off/);
    expect(describeTrustProxy(1)).toMatch(/1 trusted proxy$/);
    expect(describeTrustProxy(2)).toMatch(/2 trusted proxies$/);
    expect(describeTrustProxy(['10.0.0.0/8'])).toMatch(/10\.0\.0\.0\/8/);
  });
});
