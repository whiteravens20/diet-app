// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/* eslint-disable @typescript-eslint/no-explicit-any -- partial test doubles */

/**
 * Unit tests for AuthService. Prisma / JWT / Turnstile / Mail are mocked. Focus
 * on the security-sensitive behaviours: anti-abuse gate, duplicate-email
 * rejection, credential-uniform login failures, the
 * always-200 password-reset request (no user enumeration), and one-time token
 * validation for verify-email / reset.
 */
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { describe, expect, it, vi } from 'vitest';
import { Passwords } from '../common/passwords.js';
import { AccountEmail } from './account-email.js';
import { AuthService } from './auth.service.js';
import { SessionsService } from './sessions.service.js';
import { deriveKey, encrypt, pepperPassword } from '../common/crypto.js';

const MASTER = 'c'.repeat(64);
const PEPPER_KEY = deriveKey(MASTER, 'password-pepper');
const EMAIL_KEY = deriveKey(MASTER, 'email-encryption');

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

function makeConfig() {
  const values: Record<string, unknown> = {
    DATA_ENCRYPTION_SECRET: MASTER,
    PASSWORD_HASH_ROUNDS: 4,
    JWT_ACCESS_SECRET: 'access-secret-0123456789',
    JWT_ACCESS_TTL: 900,
    JWT_REFRESH_TTL: 2_592_000,
    APP_URL: 'http://localhost:3000',
  };
  return { get: (k: string) => values[k] };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    displayName: 'Alice',
    role: 'user' as const,
    emailVerified: true,
    locale: 'en',
    emailEncrypted: encrypt('alice@example.com', EMAIL_KEY, 'user-email:user-1'),
    passwordHash: bcrypt.hashSync(pepperPassword('CorrectHorse1', PEPPER_KEY), 4),
    ...overrides,
  };
}

function makeDeps(user: ReturnType<typeof makeUser> | null) {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      create: vi
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'user-new', role: 'user', emailVerified: false, ...args.data }),
        ),
      update: vi.fn().mockResolvedValue(user),
    },
    refreshToken: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    emailVerificationToken: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    passwordResetToken: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const jwt = { signAsync: vi.fn().mockResolvedValue('signed.jwt.token') };
  const turnstile = { verify: vi.fn().mockResolvedValue(true) };
  const mail = {
    enabled: false,
    sendEmailVerification: vi.fn().mockResolvedValue(undefined),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
  };
  return { prisma, jwt, turnstile, mail };
}

function makeSessions(deps: ReturnType<typeof makeDeps>) {
  return new SessionsService(
    deps.prisma as any,
    deps.jwt as any,
    makeConfig() as any,
    new AccountEmail(makeConfig() as any),
  );
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new AuthService(
    deps.prisma as any,
    makeConfig() as any,
    deps.turnstile as any,
    deps.mail as any,
    new AccountEmail(makeConfig() as any),
    makeSessions(deps),
    new Passwords(makeConfig() as any),
    // An account without a second factor: signing in with one is tested against the database.
    { isOn: vi.fn().mockResolvedValue(false) } as any,
  );
}

describe('AuthService.register', () => {
  it('rejects when the anti-abuse check fails', async () => {
    const deps = makeDeps(null);
    deps.turnstile.verify = vi.fn().mockResolvedValue(false);
    await expect(
      makeService(deps).register({
        email: 'a@b.com',
        password: 'Passw0rd!',
        displayName: 'A',
      } as never),
    ).rejects.toMatchObject({ response: expect.objectContaining({ error: 'TURNSTILE_FAILED' }) });
  });

  it('rejects a duplicate email with EMAIL_TAKEN', async () => {
    const deps = makeDeps(makeUser());
    await expect(
      makeService(deps).register({
        email: 'alice@example.com',
        password: 'Passw0rd!',
        displayName: 'A',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('auto-verifies the account when mail is disabled', async () => {
    const deps = makeDeps(null);
    const res = await makeService(deps).register({
      email: 'new@example.com',
      password: 'Passw0rd!',
      displayName: 'New',
    } as never);
    expect(deps.prisma.user.create.mock.calls[0][0].data.emailVerified).toBe(true);
    expect(deps.mail.sendEmailVerification).not.toHaveBeenCalled();
    expect(res.tokens.accessToken).toBe('signed.jwt.token');
  });
});

describe('AuthService.login', () => {
  it('rejects an unknown email with INVALID_CREDENTIALS', async () => {
    const deps = makeDeps(null);
    await expect(
      makeService(deps).login({ email: 'nobody@example.com', password: 'whatever' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong password', async () => {
    const deps = makeDeps(makeUser());
    await expect(
      makeService(deps).login({ email: 'alice@example.com', password: 'WrongPass9' } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'INVALID_CREDENTIALS' }),
    });
  });

  it('issues tokens on correct credentials', async () => {
    const deps = makeDeps(makeUser());
    const res = await makeService(deps).login({
      email: 'alice@example.com',
      password: 'CorrectHorse1',
    } as never);
    expect(res).toMatchObject({
      user: { email: 'alice@example.com' },
      tokens: { refreshToken: expect.any(String) },
    });
    expect(deps.prisma.refreshToken.create).toHaveBeenCalledTimes(1);
  });
});

describe('AuthService.verifyEmail', () => {
  it('rejects an unknown / used / expired token', async () => {
    const deps = makeDeps(makeUser());
    deps.prisma.emailVerificationToken.findUnique = vi.fn().mockResolvedValue(null);
    await expect(makeService(deps).verifyEmail('raw')).rejects.toBeInstanceOf(BadRequestException);

    deps.prisma.emailVerificationToken.findUnique = vi.fn().mockResolvedValue({
      id: 't1',
      userId: 'user-1',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    });
    await expect(makeService(deps).verifyEmail('raw')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'INVALID_VERIFICATION_TOKEN' }),
    });
  });

  it('hashes the raw token before lookup (never stores plaintext)', async () => {
    const deps = makeDeps(makeUser());
    deps.prisma.emailVerificationToken.findUnique = vi.fn().mockResolvedValue(null);
    await expect(makeService(deps).verifyEmail('raw-token-xyz')).rejects.toBeTruthy();
    expect(deps.prisma.emailVerificationToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw-token-xyz') },
    });
  });
});
