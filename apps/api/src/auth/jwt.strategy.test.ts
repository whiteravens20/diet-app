// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for JwtStrategy.validate: who becomes `request.user` once a
 * token's signature, algorithm, audience and expiry were accepted (those are
 * tested with real tokens in `access-token.int.test.ts`).
 */
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JwtStrategy } from './jwt.strategy.js';

/** The strategy, with the accounts that exist. */
function makeStrategy(accounts: string[] = ['user-1']) {
  const config = { get: () => 'access-secret-0123456789' };
  const findUnique = vi.fn(({ where }: { where: { id: string } }) => Promise.resolve(accounts.includes(where.id) ? { id: where.id } : null));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles
  return { strategy: new JwtStrategy(config as any, { user: { findUnique } } as any), findUnique };
}

describe('JwtStrategy.validate', () => {
  it('takes the account a token names, and nothing else from it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a payload with more than a token should hold
    const user = await makeStrategy().strategy.validate({ sub: 'user-1', email: 'a@b.com', role: 'admin' } as any);
    expect(user).toEqual({ id: 'user-1' });
  });

  it('rejects a token of an account that is gone', async () => {
    await expect(makeStrategy([]).strategy.validate({ sub: 'user-1' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects any token missing a sub, without asking for an account', async () => {
    const { strategy, findUnique } = makeStrategy();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed payload
    await expect(strategy.validate({ label: 'translator' } as any)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(strategy.validate({ sub: '' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
