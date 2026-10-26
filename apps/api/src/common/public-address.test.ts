// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './public-address.js';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.127.0.1',
    '198.19.0.1',
    '239.255.255.250',
    '::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.0.1',
    '64:ff9b::a00:1',
    'not-an-address',
    '',
  ])('%s is not', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});
