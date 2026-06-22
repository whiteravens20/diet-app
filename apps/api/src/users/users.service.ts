import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ChangeEmailRequest,
  ChangePasswordRequest,
  DeleteAccountRequest,
  SessionUser,
  UpdateUserSettings,
} from '@diet-app/shared';
import { AiMode, Locale, Palette, Theme } from '@diet-app/shared';
import * as bcrypt from 'bcryptjs';
import { blindIndex, decrypt, deriveKey, encrypt, pepperPassword } from '../common/crypto.js';
import type { Env } from '../config/env.js';
import { AuthService } from '../auth/auth.service.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `users` covers the account-mutation surface that auth doesn't: reading the
 * current session user (including locale/theme), patching settings, rotating
 * password (with current-password proof), and hard-deleting the account.
 *
 * Auth-flow concerns (login, refresh, password-reset link) stay in `auth/`.
 */
@Injectable()
export class UsersService {
  private readonly emailKey: string;
  private readonly emailIndexKey: string;
  private readonly pepperKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly mail: MailService,
    private readonly auth: AuthService,
  ) {
    const master = this.config.get('DATA_ENCRYPTION_SECRET', { infer: true });
    this.emailKey = deriveKey(master, 'email-encryption');
    this.emailIndexKey = deriveKey(master, 'email-blind-index');
    this.pepperKey = deriveKey(master, 'password-pepper');
  }

  async getMe(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Account not found.' });
    return this.toSessionUser(user);
  }

  async updateSettings(userId: string, dto: UpdateUserSettings): Promise<SessionUser> {
    // Zod has already validated locale/theme/palette/aiMode against the
    // supported enums, but we re-validate at the boundary in case a runtime
    // caller bypasses it.
    if (dto.locale !== undefined) Locale.parse(dto.locale);
    if (dto.theme !== undefined) Theme.parse(dto.theme);
    if (dto.palette !== undefined) Palette.parse(dto.palette);
    if (dto.aiMode !== undefined) AiMode.parse(dto.aiMode);
    if (
      dto.displayName === undefined &&
      dto.locale === undefined &&
      dto.theme === undefined &&
      dto.palette === undefined &&
      dto.aiMode === undefined
    ) {
      throw new BadRequestException({ error: 'EMPTY_UPDATE', message: 'Nothing to update.' });
    }
    // Flipping to `byok` with zero enabled provider configs would silently
    // produce an empty failover chain and every AI feature would fall back to
    // deterministic — the user would think they enabled AI but nothing
    // happens. Reject the flip and tell the UI to point at the providers card.
    if (dto.aiMode === 'byok') {
      const enabled = await this.prisma.aiProviderConfig.count({
        where: { userId, enabled: true },
      });
      if (enabled === 0) {
        throw new BadRequestException({
          error: 'BYOK_NO_PROVIDER',
          message: 'Add at least one provider key before switching to bring-your-own.',
        });
      }
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.theme !== undefined ? { theme: dto.theme } : {}),
        ...(dto.palette !== undefined ? { palette: dto.palette } : {}),
        ...(dto.aiMode !== undefined ? { aiMode: dto.aiMode } : {}),
      },
    });
    return this.toSessionUser(user);
  }

  async changePassword(userId: string, dto: ChangePasswordRequest): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Account not found.' });
    const ok = await bcrypt.compare(
      pepperPassword(dto.currentPassword, this.pepperKey),
      user.passwordHash,
    );
    if (!ok) {
      throw new UnauthorizedException({
        error: 'INVALID_PASSWORD',
        message: 'Current password is incorrect.',
      });
    }
    const rounds = this.config.get('PASSWORD_HASH_ROUNDS', { infer: true });
    const passwordHash = await bcrypt.hash(
      pepperPassword(dto.newPassword, this.pepperKey),
      rounds,
    );
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      // Invalidate every active session so the rotation actually forces a re-login
      // everywhere the credentials might be cached.
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // Best-effort "your password was changed" notice. Never let a mail hiccup
    // fail the password change itself.
    if (this.mail.enabled) {
      try {
        await this.mail.sendPasswordChangedNotice(
          decrypt(user.emailEncrypted, this.emailKey),
          Locale.parse(user.locale),
        );
      } catch {
        // swallow — the password was already rotated successfully.
      }
    }
  }

  /**
   * Requests an email change. Only available when SMTP is configured (the one
   * email action gated entirely on mail): a confirmation link is sent to the
   * NEW address and the change only lands once that link is followed
   * (`AuthService.confirmEmailChange`).
   */
  async requestEmailChange(userId: string, dto: ChangeEmailRequest): Promise<void> {
    if (!this.mail.enabled) {
      throw new BadRequestException({
        error: 'EMAIL_CHANGE_REQUIRES_SMTP',
        message: 'Changing your email requires the operator to configure SMTP.',
      });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Account not found.' });
    const ok = await bcrypt.compare(
      pepperPassword(dto.currentPassword, this.pepperKey),
      user.passwordHash,
    );
    if (!ok) {
      throw new UnauthorizedException({
        error: 'INVALID_PASSWORD',
        message: 'Current password is incorrect.',
      });
    }
    const newEmail = dto.newEmail.trim().toLowerCase();
    const newEmailIndex = blindIndex(newEmail, this.emailIndexKey);
    // Covers both "already in use by someone else" and "this is already your
    // address" — either way there's nothing to change.
    const clash = await this.prisma.user.findUnique({ where: { emailIndex: newEmailIndex } });
    if (clash) throw new BadRequestException({ error: 'EMAIL_TAKEN', message: 'Email already registered.' });

    const raw = randomBytes(32).toString('hex');
    await this.prisma.emailChangeToken.create({
      data: {
        userId,
        newEmailEncrypted: encrypt(newEmail, this.emailKey),
        newEmailIndex,
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const link = `${this.config.get('APP_URL', { infer: true })}/confirm-email-change?token=${raw}`;
    await this.mail.sendEmailChange(newEmail, link, Locale.parse(user.locale));
  }

  /** Re-sends the verification email for a logged-in, still-unverified user. */
  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Account not found.' });
    if (user.emailVerified) {
      throw new BadRequestException({
        error: 'EMAIL_ALREADY_VERIFIED',
        message: 'This email address is already verified.',
      });
    }
    await this.auth.sendVerificationEmail(
      userId,
      decrypt(user.emailEncrypted, this.emailKey),
      Locale.parse(user.locale),
    );
  }

  async deleteAccount(userId: string, dto: DeleteAccountRequest): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Account not found.' });
    const ok = await bcrypt.compare(
      pepperPassword(dto.currentPassword, this.pepperKey),
      user.passwordHash,
    );
    if (!ok) {
      throw new UnauthorizedException({
        error: 'INVALID_PASSWORD',
        message: 'Current password is incorrect.',
      });
    }
    // Cascade-deletes everything user-owned: profiles, plans, favorites,
    // inventory, refresh tokens, AI configs. AiUsageLog and AuditLog rows
    // are kept (userId set null) so aggregate instance stats stay intact.
    await this.prisma.user.delete({ where: { id: userId } });
  }

  private toSessionUser(user: {
    id: string;
    emailEncrypted: string;
    displayName: string;
    role: 'user' | 'admin';
    emailVerified: boolean;
    locale: string;
    theme: string;
    palette: string;
    aiMode: string;
  }): SessionUser {
    return {
      id: user.id,
      email: decrypt(user.emailEncrypted, this.emailKey),
      displayName: user.displayName,
      role: user.role,
      emailVerified: user.emailVerified,
      locale: Locale.parse(user.locale),
      theme: Theme.parse(user.theme),
      palette: Palette.parse(user.palette),
      aiMode: AiMode.parse(user.aiMode),
    };
  }
}
