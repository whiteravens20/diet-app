// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { countedAddress } from './client-address.js';

describe('the client an address is counted as', () => {
  it('is the address itself for IPv4, however it is written', () => {
    expect(countedAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(countedAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(countedAddress('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('is the /64 network for IPv6, so that one machine is one client', () => {
    const first = countedAddress('2001:db8:1:2:3:4:5:6');

    expect(first).toBe('2001:db8:1:2::/64');
    expect(countedAddress('2001:db8:1:2::1')).toBe(first);
    expect(countedAddress('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe(first);
    expect(countedAddress('2001:db8:1:3::1')).not.toBe(first);
  });

  it('leaves the interface out of a link-local address', () => {
    expect(countedAddress('fe80::1%eth0')).toBe(countedAddress('fe80::2%wlan0'));
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'unknown',
    'made up',
    '203.0.113.7, 198.51.100.1',
    '203.0.113.999',
    'x'.repeat(5000),
  ])('is one unknown client for %j, which is not an address', (value) => {
    expect(countedAddress(value)).toBe('unknown');
  });
});
