// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { isAdminSession, isAdministrator, sameText, signAdminSession } from './admin-session.js';

const configOf = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as never;
const INSTANCE = {
  DATA_ENCRYPTION_SECRET: 'c3'.repeat(32),
  ADMIN_USER: 'admin',
  ADMIN_PASSWORD: 'a-long-admin-password',
};

describe('comparing a value that was given with the one the instance holds', () => {
  it('says yes for the same value, whatever is in it', () => {
    expect(sameText('a-long-admin-password', 'a-long-admin-password')).toBe(true);
    expect(sameText('', '')).toBe(true);
    expect(sameText('zażółć gęślą jaźń 🔐', 'zażółć gęślą jaźń 🔐')).toBe(true);
  });

  it('says no for another value, a shorter or a longer one', () => {
    expect(sameText('a-long-admin-passworD', 'a-long-admin-password')).toBe(false);
    expect(sameText('a-long-admin-passwor', 'a-long-admin-password')).toBe(false);
    expect(sameText('a-long-admin-password1', 'a-long-admin-password')).toBe(false);
    expect(sameText('', 'a-long-admin-password')).toBe(false);
    expect(sameText('a-long-admin-password', '')).toBe(false);
  });

  it('does not take a value for the same value with zero bytes after it', () => {
    expect(sameText('secret\0', 'secret')).toBe(false);
    expect(sameText('secret', 'secret\0\0')).toBe(false);
  });

  it('holds for values longer than the block they are compared in', () => {
    const long = 'x'.repeat(5000);

    expect(sameText(long, long)).toBe(true);
    expect(sameText(`${long}y`, long)).toBe(false);
    expect(sameText(long, `${long}y`)).toBe(false);
    expect(sameText(long, 'x'.repeat(1024))).toBe(false);
    expect(sameText('x'.repeat(1024), long)).toBe(false);
  });
});

describe('the credentials of the instance', () => {
  it('are both needed, as they are written', () => {
    const config = configOf(INSTANCE);

    expect(isAdministrator(config, 'admin', 'a-long-admin-password')).toBe(true);
    expect(isAdministrator(config, 'admin', 'A-long-admin-password')).toBe(false);
    expect(isAdministrator(config, 'Admin', 'a-long-admin-password')).toBe(false);
    expect(isAdministrator(config, 'a-long-admin-password', 'admin')).toBe(false);
  });

  it('leave a mark in a session that is the same at every start, and another for other credentials', () => {
    const session = signAdminSession(configOf(INSTANCE), 0);

    expect(isAdminSession(configOf({ ...INSTANCE }), session, 0)).toBe(true);
    expect(
      isAdminSession(
        configOf({ ...INSTANCE, ADMIN_PASSWORD: 'another-admin-password' }),
        session,
        0,
      ),
    ).toBe(false);
    expect(isAdminSession(configOf({ ...INSTANCE, ADMIN_USER: 'root' }), session, 0)).toBe(false);
    // The two values are kept apart: one moved into the other is not the same pair.
    expect(
      isAdminSession(
        configOf({ ...INSTANCE, ADMIN_USER: 'admin","a', ADMIN_PASSWORD: '-long-admin-password' }),
        session,
        0,
      ),
    ).toBe(false);
  });

  it('are nowhere in the session, nor is a plain digest of them', () => {
    const session = signAdminSession(configOf(INSTANCE), 0);
    const claims = JSON.parse(Buffer.from(session.split('.')[1]!, 'base64url').toString()) as {
      credentials: string;
    };

    expect(claims.credentials).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(claims)).not.toContain('a-long-admin-password');
  });
});
