// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/* eslint-disable @typescript-eslint/no-explicit-any -- partial test doubles and payloads a token should not hold */

/**
 * Unit tests for JwtStrategy.validate: who becomes `request.user` once a
 * token's signature, algorithm, audience and expiry were accepted (those are
 * tested with real tokens in `access-token.int.test.ts`).
 */
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JwtStrategy } from './jwt.strategy.js';

/** The strategy, with the sessions that are open: `account/session`. */
function makeStrategy(open: string[] = ['user-1/session-1']) {
  const config = { get: () => 'access-secret-0123456789' };
  const isOpen = vi.fn((userId: string, sessionId: string) =>
    Promise.resolve(open.includes(`${userId}/${sessionId}`)),
  );
  return { strategy: new JwtStrategy(config as any, { isOpen } as any), isOpen };
}

describe('JwtStrategy.validate', () => {
  it('takes the account and the session a token names, and nothing else from it', async () => {
    const user = await makeStrategy().strategy.validate({
      sub: 'user-1',
      sid: 'session-1',
      email: 'a@b.com',
      role: 'admin',
    } as any);
    expect(user).toEqual({ id: 'user-1', sessionId: 'session-1' });
  });

  it('rejects a token whose session is not open: ended, or of an account that is gone', async () => {
    await expect(
      makeStrategy([]).strategy.validate({ sub: 'user-1', sid: 'session-1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token that names the session of another account', async () => {
    await expect(
      makeStrategy(['user-2/session-1']).strategy.validate({ sub: 'user-1', sid: 'session-1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects any token that names no account or no session, without looking anything up', async () => {
    const { strategy, isOpen } = makeStrategy();

    for (const payload of [
      { label: 'translator' },
      { sub: '', sid: 'session-1' },
      { sub: 'user-1' },
      { sub: 'user-1', sid: '' },
    ] as any[]) {
      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(isOpen).not.toHaveBeenCalled();
  });
});
