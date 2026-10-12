// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for UsersService. Prisma is mocked — the goal is to lock down
 * the small but security-sensitive behaviours: current-password proof for
 * password change and account delete, empty-update rejection, and
 * session-invalidation on password rotation.
 */
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { AccountEmail } from '../auth/account-email.js';
import { Passwords } from '../common/passwords.js';
import { deriveKey, encrypt, pepperPassword } from '../common/crypto.js';
import { UsersService } from './users.service.js';

const MASTER = 'a'.repeat(64);
const PEPPER_KEY = deriveKey(MASTER, 'password-pepper');
const EMAIL_KEY = deriveKey(MASTER, 'email-encryption');

const config = {
  get: (key: string) => {
    if (key === 'DATA_ENCRYPTION_SECRET') return MASTER;
    if (key === 'PASSWORD_HASH_ROUNDS') return 4; // fast for tests
    throw new Error(`unexpected config key ${key}`);
  },
};

// Mail off by default — the password/settings/delete paths under test don't
// depend on delivery, and `enabled: false` skips the notice email.
const mail = { enabled: false, sendPasswordChangedNotice: vi.fn() };
const auth = { resendVerificationEmail: vi.fn() };

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    emailEncrypted: encrypt('alice@example.com', EMAIL_KEY, 'user-email:user-1'),
    displayName: 'Alice',
    role: 'user' as const,
    emailVerified: false,
    locale: 'en',
    theme: 'system',
    palette: 'default',
    aiMode: 'none',
    weightUnit: null,
    passwordHash: bcrypt.hashSync(pepperPassword('CorrectHorse1', PEPPER_KEY), 4),
    ...overrides,
  };
}

function makePrisma(user: ReturnType<typeof makeUser> | null, enabledProviderCount = 0) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...(user ?? {}), ...args.data }),
      ),
      delete: vi.fn().mockResolvedValue(user),
    },
    aiProviderConfig: { count: vi.fn().mockResolvedValue(enabledProviderCount) },
    refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

describe('UsersService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: UsersService;

  beforeEach(() => {
    prisma = makePrisma(makeUser());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles; casting to the real constructor types here is noise
    service = new UsersService(prisma as any, config as any, mail as any, auth as any, new AccountEmail(config as any), new Passwords(config as any));
  });

  describe('getMe', () => {
    it('decrypts email and returns SessionUser shape', async () => {
      const me = await service.getMe('user-1');
      expect(me.email).toBe('alice@example.com');
      expect(me.locale).toBe('en');
      expect(me.theme).toBe('system');
    });

    it('throws USER_NOT_FOUND when missing', async () => {
      prisma = makePrisma(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles; casting to the real constructor types here is noise
      service = new UsersService(prisma as any, config as any, mail as any, auth as any, new AccountEmail(config as any), new Passwords(config as any));
      await expect(service.getMe('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateSettings', () => {
    it('rejects an entirely empty patch', async () => {
      await expect(service.updateSettings('user-1', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updates only the provided fields', async () => {
      await service.updateSettings('user-1', { locale: 'pl' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { locale: 'pl' },
      });
    });

    it('keeps the unit an account weighs in, takes it back when told to, and says it with the account', async () => {
      await service.updateSettings('user-1', { weightUnit: 'lb' });
      await service.updateSettings('user-1', { weightUnit: null });

      expect(prisma.user.update.mock.calls.map(([arg]) => arg.data)).toEqual([{ weightUnit: 'lb' }, { weightUnit: null }]);
      prisma.user.findUnique.mockResolvedValueOnce({ ...makeUser(), weightUnit: 'lb' });
      expect((await service.getMe('user-1')).weightUnit).toBe('lb');
      // What is kept and is no unit is no choice: the client goes by where its reader is.
      prisma.user.findUnique.mockResolvedValueOnce({ ...makeUser(), weightUnit: 'stone' });
      expect((await service.getMe('user-1')).weightUnit).toBeNull();
    });

    it('rejects byok flip when the user has zero enabled provider configs', async () => {
      prisma = makePrisma(makeUser(), 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles; casting to the real constructor types here is noise
      service = new UsersService(prisma as any, config as any, mail as any, auth as any, new AccountEmail(config as any), new Passwords(config as any));
      await expect(service.updateSettings('user-1', { aiMode: 'byok' })).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'BYOK_NO_PROVIDER' }),
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('allows byok flip when at least one provider config is enabled', async () => {
      prisma = makePrisma(makeUser(), 1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles; casting to the real constructor types here is noise
      service = new UsersService(prisma as any, config as any, mail as any, auth as any, new AccountEmail(config as any), new Passwords(config as any));
      await service.updateSettings('user-1', { aiMode: 'byok' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { aiMode: 'byok' },
      });
    });
  });

  describe('changePassword', () => {
    it('rejects an incorrect current password', async () => {
      await expect(
        service.changePassword('user-1', {
          currentPassword: 'WrongPassword1',
          newPassword: 'NewSecurePass1',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    // What a change of password does is tested on a real database, in auth/one-time-links.int.test.ts.
  });

  describe('deleteAccount', () => {
    it('rejects an incorrect current password', async () => {
      await expect(
        service.deleteAccount('user-1', { currentPassword: 'WrongPassword1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    // What a deletion removes is tested on a real database, in account-deletion.int.test.ts.
  });
});
