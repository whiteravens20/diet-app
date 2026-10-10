// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for AuthService. Prisma / JWT / Turnstile / Mail are mocked. Focus
 * on the security-sensitive behaviours: anti-abuse gate, duplicate-email
 * rejection, credential-uniform login failures, refresh-token rotation, the
 * always-200 password-reset request (no user enumeration), and one-time token
 * validation for verify-email / reset.
 */
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
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
    emailEncrypted: encrypt('alice@example.com', EMAIL_KEY),
    passwordHash: bcrypt.hashSync(pepperPassword('CorrectHorse1', PEPPER_KEY), 4),
    ...overrides,
  };
}

function makeDeps(user: ReturnType<typeof makeUser> | null) {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
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

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new AuthService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles
    deps.prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles
    deps.jwt as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles
    makeConfig() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles
    deps.turnstile as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles
    deps.mail as any,
  );
}

describe('AuthService.register', () => {
  it('rejects when the anti-abuse check fails', async () => {
    const deps = makeDeps(null);
    deps.turnstile.verify = vi.fn().mockResolvedValue(false);
    await expect(
      makeService(deps).register({ email: 'a@b.com', password: 'Passw0rd!', displayName: 'A' } as never),
    ).rejects.toMatchObject({ response: expect.objectContaining({ error: 'TURNSTILE_FAILED' }) });
  });

  it('rejects a duplicate email with EMAIL_TAKEN', async () => {
    const deps = makeDeps(makeUser());
    await expect(
      makeService(deps).register({ email: 'alice@example.com', password: 'Passw0rd!', displayName: 'A' } as never),
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

  it('sends a verification email when mail is enabled', async () => {
    const deps = makeDeps(null);
    deps.mail.enabled = true;
    await makeService(deps).register({ email: 'new@example.com', password: 'Passw0rd!', displayName: 'New' } as never);
    expect(deps.prisma.user.create.mock.calls[0][0].data.emailVerified).toBe(false);
    expect(deps.mail.sendEmailVerification).toHaveBeenCalledTimes(1);
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
    ).rejects.toMatchObject({ response: expect.objectContaining({ error: 'INVALID_CREDENTIALS' }) });
  });

  it('issues tokens on correct credentials', async () => {
    const deps = makeDeps(makeUser());
    const res = await makeService(deps).login({ email: 'alice@example.com', password: 'CorrectHorse1' } as never);
    expect(res.user.email).toBe('alice@example.com');
    expect(res.tokens.refreshToken).toBeTypeOf('string');
    expect(deps.prisma.refreshToken.create).toHaveBeenCalledTimes(1);
  });

  // Regression: the miss path must run a *real* bcrypt compare so its timing
  // matches a wrong-password hit — otherwise login is an account-enumeration
  // timing oracle. A valid dummy hash at the configured cost is the guarantee;
  // the prior malformed constant let bcrypt.compare fail-fast (~0ms). We assert
  // the dummy is a well-formed bcrypt hash at the configured rounds rather than
  // wall-clock timing (which is flaky in CI).
  it('compares against a valid bcrypt hash on an unknown email (no timing oracle)', async () => {
    const svc = makeService(makeDeps(null));
    const dummy = (svc as unknown as { dummyHash: string }).dummyHash;
    expect(dummy).toMatch(/^\$2[aby]\$04\$/); // configured PASSWORD_HASH_ROUNDS = 4 in tests
    expect(bcrypt.compareSync('anything', dummy)).toBe(false);
  });
});

describe('AuthService.refresh', () => {
  it('rejects an unknown refresh token', async () => {
    const deps = makeDeps(makeUser());
    await expect(makeService(deps).refresh('bogus')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a revoked token', async () => {
    const deps = makeDeps(makeUser());
    deps.prisma.refreshToken.findUnique = vi.fn().mockResolvedValue({
      id: 'rt-1',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 100000),
      user: makeUser(),
    });
    await expect(makeService(deps).refresh('tok')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'INVALID_REFRESH' }),
    });
  });

  it('rotates: revokes the used token and issues a fresh pair', async () => {
    const deps = makeDeps(makeUser());
    deps.prisma.refreshToken.findUnique = vi.fn().mockResolvedValue({
      id: 'rt-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 100000),
      user: makeUser(),
    });
    const res = await makeService(deps).refresh('tok');
    expect(deps.prisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(res.tokens.accessToken).toBe('signed.jwt.token');
  });
});

describe('AuthService.requestPasswordReset', () => {
  it('never throws / leaks when the email is unknown (no enumeration)', async () => {
    const deps = makeDeps(null);
    await expect(
      makeService(deps).requestPasswordReset({ email: 'ghost@example.com' } as never),
    ).resolves.toBeUndefined();
    expect(deps.prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('creates a reset token for a known user', async () => {
    const deps = makeDeps(makeUser());
    await makeService(deps).requestPasswordReset({ email: 'alice@example.com' } as never);
    expect(deps.prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
  });
});

describe('AuthService.verifyEmail', () => {
  it('rejects an unknown / used / expired token', async () => {
    const deps = makeDeps(makeUser());
    deps.prisma.emailVerificationToken.findUnique = vi.fn().mockResolvedValue(null);
    await expect(makeService(deps).verifyEmail('raw')).rejects.toBeInstanceOf(BadRequestException);

    deps.prisma.emailVerificationToken.findUnique = vi.fn().mockResolvedValue({
      id: 't1', userId: 'user-1', usedAt: new Date(), expiresAt: new Date(Date.now() + 1000),
    });
    await expect(makeService(deps).verifyEmail('raw')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'INVALID_VERIFICATION_TOKEN' }),
    });
  });

  it('marks the user verified and consumes the token', async () => {
    const deps = makeDeps(makeUser());
    deps.prisma.emailVerificationToken.findUnique = vi.fn().mockResolvedValue({
      id: 't1', userId: 'user-1', usedAt: null, expiresAt: new Date(Date.now() + 100000),
    });
    await makeService(deps).verifyEmail('raw');
    expect(deps.prisma.$transaction).toHaveBeenCalledTimes(1);
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
