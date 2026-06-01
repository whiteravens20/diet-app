/**
 * Unit tests for UsersService. Prisma is mocked — the goal is to lock down
 * the small but security-sensitive behaviours: current-password proof for
 * password change and account delete, empty-update rejection, and
 * session-invalidation on password rotation.
 */
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { describe, expect, it, beforeEach, vi } from 'vitest';
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

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    emailEncrypted: encrypt('alice@example.com', EMAIL_KEY),
    displayName: 'Alice',
    role: 'user' as const,
    emailVerified: false,
    locale: 'en',
    theme: 'system',
    palette: 'default',
    aiMode: 'none',
    passwordHash: bcrypt.hashSync(pepperPassword('CorrectHorse1', PEPPER_KEY), 4),
    ...overrides,
  };
}

function makePrisma(user: ReturnType<typeof makeUser> | null) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...(user ?? {}), ...args.data }),
      ),
      delete: vi.fn().mockResolvedValue(user),
    },
    refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

describe('UsersService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: UsersService;

  beforeEach(() => {
    prisma = makePrisma(makeUser());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new UsersService(prisma as any, config as any);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service = new UsersService(prisma as any, config as any);
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

    it('rotates the password and invalidates active refresh tokens', async () => {
      await service.changePassword('user-1', {
        currentPassword: 'CorrectHorse1',
        newPassword: 'BrandNewPass1',
      });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({ passwordHash: expect.any(String) }),
        }),
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('deleteAccount', () => {
    it('rejects an incorrect current password', async () => {
      await expect(
        service.deleteAccount('user-1', { currentPassword: 'WrongPassword1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('delegates to prisma.user.delete on success (cascade handled at DB level)', async () => {
      await service.deleteAccount('user-1', { currentPassword: 'CorrectHorse1' });
      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    });
  });
});
