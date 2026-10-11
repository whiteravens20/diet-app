// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LoginRequest,
  PasswordResetConfirm,
  PasswordResetRequest,
  RegisterRequest,
} from '@diet-app/shared';
import { Locale } from '@diet-app/shared';
import { deriveKey, pepperPassword } from '../common/crypto.js';
import { hashPassword, hashPasswordAtStartup, verifyPassword } from '../common/password-hash.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountEmail } from './account-email.js';
import { retirePendingLinks } from './one-time-links.js';
import { type OpenedSession, SessionsService } from './sessions.service.js';
import { TurnstileService } from './turnstile.service.js';

/** An account may ask for its verification mail again this long after the last one went out. */
const VERIFICATION_RESEND_WAIT_MS = 2 * 60_000;
/** A link with less time left than this is not sent again: a new one is made. */
const VERIFICATION_LINK_WORTH_SENDING_MS = 10 * 60_000;

@Injectable()
export class AuthService {
  private readonly pepperKey: string;
  private readonly linkKey: string;
  /**
   * A *valid* bcrypt hash at the configured cost, computed once at startup, so
   * the login "no such user" path spends the same time as a real password
   * compare. A malformed/hardcoded constant lets `bcrypt.compare` fail-fast
   * (returning in ~0ms instead of ~250ms), which leaks account existence
   * through a response-timing oracle. Derived from the live rounds so it stays
   * uniform even if the operator retunes `PASSWORD_HASH_ROUNDS`.
   */
  private readonly dummyHash: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly turnstile: TurnstileService,
    private readonly mail: MailService,
    private readonly emails: AccountEmail,
    private readonly sessions: SessionsService,
  ) {
    const master = this.config.get('DATA_ENCRYPTION_SECRET', { infer: true });
    this.pepperKey = deriveKey(master, 'password-pepper');
    this.linkKey = deriveKey(master, 'verification-link');
    this.dummyHash = hashPasswordAtStartup(
      'uniform-timing-placeholder',
      this.config.get('PASSWORD_HASH_ROUNDS', { infer: true }),
    );
  }

  async register(dto: RegisterRequest, locale: Locale = 'en', openedFrom: string | null = null): Promise<OpenedSession> {
    await this.assertHuman(dto.turnstileToken);
    const email = this.emails.normalise(dto.email);
    const emailIndex = this.emails.indexOf(email);

    const existing = await this.prisma.user.findUnique({ where: { emailIndex } });
    if (existing) throw emailTaken();

    const rounds = this.config.get('PASSWORD_HASH_ROUNDS', { infer: true });
    const passwordHash = await this.hashPassword(dto.password, rounds);
    // The id is chosen here: the address is sealed for the account it belongs to.
    const id = randomUUID();
    const user = await this.prisma.user
      .create({
        data: {
          id,
          emailIndex,
          emailEncrypted: this.emails.seal(email, id),
          passwordHash,
          displayName: dto.displayName,
          // With mail configured the address must be confirmed via an emailed
          // link; without it there's nothing to verify against, so the account is
          // trusted-verified immediately ("od ręki").
          emailVerified: !this.mail.enabled,
        },
      })
      // Two registrations of one address can both pass the check above. The
      // unique index decides, and the one that loses gets the usual answer.
      .catch(rethrowAsEmailTaken);
    if (this.mail.enabled) await this.sendVerificationEmail(user.id, email, locale);
    return this.sessions.open(user, email, openedFrom);
  }

  /**
   * Mails the link that confirms the address of an account. While the link
   * the account was sent before is good for a while yet, the same one goes
   * out again: every mail the account holds then leads to the same place,
   * and asking again leaves no pile of valid links behind. Otherwise a new
   * link is made, and the ones before stop working.
   */
  async sendVerificationEmail(userId: string, email: string, locale: Locale): Promise<void> {
    const now = Date.now();
    const latest = await this.prisma.emailVerificationToken.findFirst({ where: { userId, usedAt: null }, orderBy: { createdAt: 'desc' } });
    // A link made before links could be sent again holds a token nobody can work out from the row.
    const sameAgain = latest && latest.expiresAt.getTime() - now > VERIFICATION_LINK_WORTH_SENDING_MS && sha256(this.verificationToken(latest.id)) === latest.tokenHash;
    let id: string;
    if (sameAgain) {
      id = latest.id;
      await this.prisma.emailVerificationToken.update({ where: { id }, data: { lastSentAt: new Date(now) } });
    } else {
      id = randomUUID();
      await this.prisma.$transaction([
        this.prisma.emailVerificationToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date(now) } }),
        this.prisma.emailVerificationToken.create({
          data: { id, userId, tokenHash: sha256(this.verificationToken(id)), expiresAt: new Date(now + 3_600_000) },
        }),
      ]);
    }
    const link = `${this.config.get('APP_URL', { infer: true })}/verify-email?token=${this.verificationToken(id)}`;
    this.mail.sendEmailVerification(email, link, locale);
  }

  /**
   * The same for an account that asks for the mail again: not within two
   * minutes of the last one. The mail may be on its way, and an account that
   * was registered with somebody else's address is no way to fill their
   * mailbox.
   */
  async resendVerificationEmail(userId: string, email: string, locale: Locale): Promise<void> {
    const latest = await this.prisma.emailVerificationToken.findFirst({ where: { userId, usedAt: null }, orderBy: { lastSentAt: 'desc' } });
    const wait = latest ? latest.lastSentAt.getTime() + VERIFICATION_RESEND_WAIT_MS - Date.now() : 0;
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      throw new HttpException(
        { error: 'VERIFICATION_SENT_RECENTLY', message: `A verification mail was sent a moment ago. Ask again in ${seconds} seconds.`, retryAfterSeconds: seconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.sendVerificationEmail(userId, email, locale);
  }

  /**
   * The token of a verification link, worked out from the id of its row with
   * a key of the application's. The row holds only its hash, as for every
   * link, and the same link can still be sent a second time.
   */
  private verificationToken(id: string): string {
    return createHmac('sha256', Buffer.from(this.linkKey, 'hex')).update(`email-verification:${id}`).digest('hex');
  }

  async login(dto: LoginRequest, openedFrom: string | null = null): Promise<OpenedSession> {
    await this.assertHuman(dto.turnstileToken);
    const email = this.emails.normalise(dto.email);
    const user = await this.prisma.user.findUnique({ where: { emailIndex: this.emails.indexOf(email) } });
    // Always run a hash comparison to keep the response time uniform.
    const ok = await verifyPassword(
      pepperPassword(dto.password, this.pepperKey),
      user?.passwordHash ?? this.dummyHash,
    );
    if (!user || !ok) {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    }
    return this.sessions.open(user, email, openedFrom);
  }

  /**
   * Never reveals whether the address has an account: not by what it
   * answers, and not by how long it takes. Whether there is an account is
   * looked up after the answer, with everything that follows from it.
   */
  async requestPasswordReset(dto: PasswordResetRequest): Promise<void> {
    await this.assertHuman(dto.turnstileToken);
    const email = this.emails.normalise(dto.email);
    this.mail.later('password reset', () => this.sendResetLink(email));
  }

  /** Make a reset link for the account of `email`, if there is one, and mail it. */
  private async sendResetLink(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { emailIndex: this.emails.indexOf(email) } });
    if (!user) return;

    const raw = randomBytes(32).toString('hex');
    await this.prisma.$transaction([
      // One link at a time: asking again makes the earlier one stop working.
      this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(raw),
          expiresAt: new Date(Date.now() + 3_600_000), // 1 hour
        },
      }),
    ]);
    const link = `${this.config.get('APP_URL', { infer: true })}/reset-password?token=${raw}`;
    // Emails the link when SMTP is configured. Without SMTP, MailService logs
    // it outside production only. Use the user's stored locale.
    this.mail.sendPasswordReset(email, link, Locale.parse(user.locale));
  }

  /** Confirms an email address from a verification link. */
  async verifyEmail(rawToken: string): Promise<void> {
    const token = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
    });
    const invalid = () =>
      new BadRequestException({
        error: 'INVALID_VERIFICATION_TOKEN',
        message: 'Verification link is invalid or expired.',
      });
    if (!token || token.usedAt || token.expiresAt < new Date()) throw invalid();
    await this.prisma.$transaction(async (tx) => {
      if (!(await usedNow(tx.emailVerificationToken, token.id))) throw invalid();
      await tx.user.update({ where: { id: token.userId }, data: { emailVerified: true } });
    });
  }

  /**
   * Confirms a pending email change from the link sent to the *new* address.
   * Re-checks the new address is still free, promotes it onto the User (marking
   * it verified), and revokes active sessions so the next sign-in uses the new
   * identity.
   */
  async confirmEmailChange(rawToken: string): Promise<void> {
    const token = await this.prisma.emailChangeToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
    });
    const invalid = () =>
      new BadRequestException({
        error: 'INVALID_EMAIL_CHANGE_TOKEN',
        message: 'Email-change link is invalid or expired.',
      });
    if (!token || token.usedAt || token.expiresAt < new Date()) throw invalid();
    const clash = await this.prisma.user.findUnique({ where: { emailIndex: token.newEmailIndex } });
    if (clash && clash.id !== token.userId) throw emailTaken();
    const account = await this.prisma.user.findUniqueOrThrow({ where: { id: token.userId }, select: { emailEncrypted: true, locale: true } });
    const newEmail = this.emails.openPending(token.newEmailEncrypted, token.userId);
    await this.prisma
      .$transaction(async (tx) => {
        if (!(await usedNow(tx.emailChangeToken, token.id))) throw invalid();
        await tx.user.update({
          where: { id: token.userId },
          data: {
            // Sealed anew: as the address of the account, no longer as one it asked for.
            emailEncrypted: this.emails.seal(newEmail, token.userId),
            emailIndex: token.newEmailIndex,
            emailVerified: true,
          },
        });
        await tx.refreshToken.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await retirePendingLinks(tx, token.userId, { addressToo: true });
      })
      // Someone registered the address after the check above.
      .catch(rethrowAsEmailTaken);
    // The address the account had is told that it has another.
    this.mail.sendEmailChangedNotice(this.emails.open(account.emailEncrypted, token.userId), newEmail, Locale.parse(account.locale));
  }

  async confirmPasswordReset(dto: PasswordResetConfirm): Promise<void> {
    const token = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(dto.token) },
    });
    const invalid = () => new BadRequestException({ error: 'INVALID_RESET_TOKEN', message: 'Reset link is invalid or expired.' });
    if (!token || token.usedAt || token.expiresAt < new Date()) throw invalid();
    const rounds = this.config.get('PASSWORD_HASH_ROUNDS', { infer: true });
    const passwordHash = await this.hashPassword(dto.password, rounds);
    await this.prisma.$transaction(async (tx) => {
      if (!(await usedNow(tx.passwordResetToken, token.id))) throw invalid();
      await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
      // Invalidate every active session.
      await tx.refreshToken.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await retirePendingLinks(tx, token.userId);
    });
    // As after a change by its holder: the account is told that its password is another now.
    const account = await this.prisma.user.findUnique({ where: { id: token.userId }, select: { emailEncrypted: true, locale: true } });
    if (account) this.mail.sendPasswordChangedNotice(this.emails.open(account.emailEncrypted, token.userId), Locale.parse(account.locale));
  }

  /** Peppers the password with an app-only key, then bcrypt-hashes it. */
  private hashPassword(password: string, rounds: number): Promise<string> {
    return hashPassword(pepperPassword(password, this.pepperKey), rounds);
  }

  private async assertHuman(token: string | undefined): Promise<void> {
    if (!(await this.turnstile.verify(token))) {
      throw new BadRequestException({ error: 'TURNSTILE_FAILED', message: 'Anti-abuse check failed.' });
    }
  }
}

/**
 * Use a link, for the one request that may: true when this call marked it
 * used, false when another had by then. Two requests that follow one link at
 * the same moment both find it unused when they look it up; only one of them
 * gets to mark it.
 */
async function usedNow(
  links: { updateMany(args: { where: { id: string; usedAt: null }; data: { usedAt: Date } }): Promise<{ count: number }> },
  id: string,
): Promise<boolean> {
  return (await links.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } })).count === 1;
}

function emailTaken(): ConflictException {
  return new ConflictException({ error: 'EMAIL_TAKEN', message: 'Email already registered.' });
}

/** Turns the unique index refusing an address into the answer a client expects. */
function rethrowAsEmailTaken(error: unknown): never {
  throw isUniqueViolation(error) ? emailTaken() : error;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
