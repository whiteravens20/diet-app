// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

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
import { Passwords } from '../common/passwords.js';
import type { Env } from '../config/env.js';
import { carryUsageOfAccount } from '../ai/ai-quota.service.js';
import { AccountEmail } from '../auth/account-email.js';
import { AuthService } from '../auth/auth.service.js';
import { retirePendingLinks } from '../auth/one-time-links.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { removePersonalRecipesOf } from '../recipes/personal-recipes.service.js';

/**
 * `users` covers the account-mutation surface that auth doesn't: reading the
 * current session user (including locale/theme), patching settings, rotating
 * password (with current-password proof), and hard-deleting the account.
 *
 * Auth-flow concerns (login, refresh, password-reset link) stay in `auth/`.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly mail: MailService,
    private readonly auth: AuthService,
    private readonly emails: AccountEmail,
    private readonly passwords: Passwords,
  ) {}

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
    const ok = await this.passwords.matches(dto.currentPassword, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException({
        error: 'INVALID_PASSWORD',
        message: 'Current password is incorrect.',
      });
    }
    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      // Invalidate every active session so the rotation actually forces a re-login
      // everywhere the credentials might be cached.
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await retirePendingLinks(tx, userId);
    });
    if (this.mail.enabled) {
      this.mail.sendPasswordChangedNotice(this.emails.open(user.emailEncrypted, user.id), Locale.parse(user.locale));
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
    const ok = await this.passwords.matches(dto.currentPassword, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException({
        error: 'INVALID_PASSWORD',
        message: 'Current password is incorrect.',
      });
    }
    const newEmail = this.emails.normalise(dto.newEmail);
    const newEmailIndex = this.emails.indexOf(newEmail);
    // Covers both "already in use by someone else" and "this is already your
    // address" — either way there's nothing to change.
    const clash = await this.prisma.user.findUnique({ where: { emailIndex: newEmailIndex } });
    if (clash) throw new BadRequestException({ error: 'EMAIL_TAKEN', message: 'Email already registered.' });

    const raw = randomBytes(32).toString('hex');
    await this.prisma.$transaction([
      // One link at a time: asking again makes the earlier one stop working.
      this.prisma.emailChangeToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.emailChangeToken.create({
        data: {
          userId,
          newEmailEncrypted: this.emails.sealPending(newEmail, userId),
          newEmailIndex,
          tokenHash: createHash('sha256').update(raw).digest('hex'),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    ]);
    const link = `${this.config.get('APP_URL', { infer: true })}/confirm-email-change?token=${raw}`;
    const locale = Locale.parse(user.locale);
    this.mail.sendEmailChange(newEmail, link, locale);
    // The address the account has is told: its holder may not be who asked.
    this.mail.sendEmailChangeRequestedNotice(this.emails.open(user.emailEncrypted, user.id), newEmail, locale);
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
    await this.auth.resendVerificationEmail(userId, this.emails.open(user.emailEncrypted, user.id), Locale.parse(user.locale));
  }

  async deleteAccount(userId: string, dto: DeleteAccountRequest): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND', message: 'Account not found.' });
    const ok = await this.passwords.matches(dto.currentPassword, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException({
        error: 'INVALID_PASSWORD',
        message: 'Current password is incorrect.',
      });
    }
    // Everything the account owns goes, in one transaction and in this order:
    // what holds a recipe before the recipes, and the account last.
    await this.prisma.$transaction(
      async (tx) => {
        const ofTheAccount = { profile: { userId } };
        // Plans, with their days, meals and shopping lists.
        await tx.mealPlan.deleteMany({ where: ofTheAccount });
        await tx.favorite.deleteMany({ where: ofTheAccount });
        await tx.favoriteSet.deleteMany({ where: ofTheAccount });
        // Its own recipes, and what the curation queue holds of them.
        await removePersonalRecipesOf(tx, userId);
        // The record of its AI calls; what they count for stays, without the account.
        await carryUsageOfAccount(tx, userId);
        // With the account itself: its profiles (their weights, notifications,
        // preferences and pantry), its provider keys and every token of it.
        await tx.user.delete({ where: { id: userId } });
      },
      { timeout: 30_000 },
    );
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
      email: this.emails.open(user.emailEncrypted, user.id),
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
