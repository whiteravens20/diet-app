// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for JwtStrategy.validate: who becomes `request.user` once a
 * token's signature, algorithm, audience and expiry were accepted (those are
 * tested with real tokens in `access-token.int.test.ts`).
 */
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { JwtStrategy } from './jwt.strategy.js';

function makeStrategy() {
  const config = { get: () => 'access-secret-0123456789' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return new JwtStrategy(config as any);
}

describe('JwtStrategy.validate', () => {
  it('takes the account a token names, and nothing else from it', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a payload with more than a token should hold
    const user = makeStrategy().validate({ sub: 'user-1', email: 'a@b.com', role: 'admin' } as any);
    expect(user).toEqual({ id: 'user-1' });
  });

  it('rejects any token missing a sub', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed payload
    expect(() => makeStrategy().validate({ label: 'translator' } as any)).toThrow(UnauthorizedException);
  });

  it('rejects an empty-string sub', () => {
    expect(() => makeStrategy().validate({ sub: '' })).toThrow(UnauthorizedException);
  });
});
