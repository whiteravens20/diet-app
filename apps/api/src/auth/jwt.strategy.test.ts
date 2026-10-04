// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for JwtStrategy.validate — the token-shape gate that decides who
 * becomes `request.user`. The security-critical case: a reviewer-session JWT
 * (signed with the same secret, `kind: 'reviewer'`, no `sub`) must NOT
 * authenticate as a user, or a `where: { userId: undefined }` query would leak
 * every user's rows.
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
  it('accepts a genuine user access token', () => {
    const user = makeStrategy().validate({ sub: 'user-1', email: 'a@b.com', role: 'user' });
    expect(user).toEqual({ id: 'user-1', email: 'a@b.com', role: 'user' });
  });

  it('rejects a reviewer-session token replayed as a Bearer token', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reviewer-shaped payload
      makeStrategy().validate({ kind: 'reviewer', label: 'translator' } as any),
    ).toThrow(UnauthorizedException);
  });

  it('rejects any token missing a sub', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed payload
    expect(() => makeStrategy().validate({ email: 'a@b.com', role: 'user' } as any)).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an empty-string sub', () => {
    expect(() => makeStrategy().validate({ sub: '', email: 'a@b.com', role: 'user' })).toThrow(
      UnauthorizedException,
    );
  });
});
