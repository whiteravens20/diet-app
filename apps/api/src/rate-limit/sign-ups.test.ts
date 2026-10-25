// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { SIGN_UPS_PER_ADDRESS_A_DAY, SignUps } from './sign-ups.js';

const DAY_MS = 86_400_000;

/** The limit as an instance sets it up: `TRUST_PROXY` as given. */
const signUps = (trustProxy: string | undefined): SignUps =>
  new SignUps({
    get: (key: string) => (key === 'TRUST_PROXY' ? trustProxy : undefined),
  } as unknown as ConfigService<Env, true>);

describe('the accounts one address may open in a day', () => {
  let limit: SignUps;
  let time: number;

  beforeEach(() => {
    limit = signUps('1');
    time = 1_000_000_000;
    limit.now = () => time;
  });

  /** The refusal of a sign-up from `address`, or null when it may go ahead. */
  const refusal = (address: string): { status: number; body: unknown } | null => {
    try {
      limit.take(address);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      return {
        status: (err as HttpException).getStatus(),
        body: (err as HttpException).getResponse(),
      };
    }
  };

  it(`are ${SIGN_UPS_PER_ADDRESS_A_DAY}: the next is refused until the first is a day old, and says how long that is`, () => {
    for (let i = 0; i < SIGN_UPS_PER_ADDRESS_A_DAY; i += 1) {
      expect(refusal('203.0.113.7')).toBeNull();
      time += 60_000;
    }

    expect(refusal('203.0.113.7')).toEqual({
      status: 429,
      body: expect.objectContaining({
        error: 'TOO_MANY_SIGN_UPS',
        retryAfterSeconds: (DAY_MS - SIGN_UPS_PER_ADDRESS_A_DAY * 60_000) / 1000,
      }),
    });
    time = 1_000_000_000 + DAY_MS + 1;
    expect(refusal('203.0.113.7')).toBeNull();
  });

  it('leave every other address its own, and count an IPv6 network as one address', () => {
    for (let i = 0; i < SIGN_UPS_PER_ADDRESS_A_DAY; i += 1) limit.take(`2001:db8:1:2::${i + 1}`);

    expect(refusal('2001:db8:1:2:ffff::9')).toMatchObject({ status: 429 });
    expect(refusal('2001:db8:1:3::1')).toBeNull();
    expect(refusal('203.0.113.7')).toBeNull();
  });

  it('count only the sign-ups that opened an account: one that failed gives its place back', () => {
    for (let i = 0; i < 10; i += 1) limit.take('203.0.113.7')();

    expect(refusal('203.0.113.7')).toBeNull();
  });

  it("are not counted where the address is the proxy's for every visitor: one visitor would keep all others from signing up", () => {
    limit = signUps(undefined);

    for (let i = 0; i < 10; i += 1) expect(refusal('172.18.0.5')).toBeNull();
  });
});
