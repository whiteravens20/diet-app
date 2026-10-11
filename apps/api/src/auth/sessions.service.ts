// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountEmail } from './account-email.js';
import { ACCOUNT_AUDIENCE, TOKEN_ALGORITHM } from './token-kinds.js';

/** The account a session is opened for, as far as its answer shows it. */
export interface SessionAccount {
  id: string;
  displayName: string;
  role: 'user' | 'admin';
  emailVerified: boolean;
}

/**
 * For this long after a refresh token was used, presenting it again is taken
 * for a second request of the same client (two tabs waking up together) and
 * not for a copy of it.
 */
const JUST_USED_MS = 10_000;

const refused = (): UnauthorizedException => new UnauthorizedException({ error: 'INVALID_REFRESH', message: 'Refresh token rejected.' });
const justRefreshed = (): ConflictException =>
  new ConflictException({ error: 'SESSION_JUST_REFRESHED', message: 'Another request refreshed this session a moment ago. Go on with what it was given.' });

/**
 * The sessions of accounts. A session begins when an account signs in and is
 * a chain of refresh tokens from then on: each is used once, for an access
 * token and the next refresh token. A refresh token is random and is kept as
 * a hash.
 *
 * A token that is presented a second time was copied: by whoever presents it
 * now, or by whoever used it first. Nobody can tell which, so the session
 * ends for both, and the account signs in again. That is what makes a copied
 * token worth nothing once its owner has gone on, and what tells the owner
 * when somebody else went on in their place.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger('Sessions');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly emails: AccountEmail,
  ) {}

  /** Open a session for an account that has just proved who it is. */
  async open(user: SessionAccount, email: string, label: string | null = null): Promise<AuthResponse> {
    const now = Date.now();
    const familyId = randomUUID();
    const familyExpiresAt = new Date(now + this.config.get('JWT_SESSION_TTL', { infer: true }) * 1000);
    const refreshToken = newToken();
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), familyId, familyExpiresAt, label, expiresAt: this.tokenExpiry(now, familyExpiresAt) },
    });
    return this.answer(user, email, refreshToken, familyId);
  }

  /** Exchange a refresh token for the next pair of its session. */
  async refresh(refreshToken: string): Promise<AuthResponse> {
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) }, include: { user: true } });
    const now = Date.now();
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < now || stored.familyExpiresAt.getTime() < now) throw refused();
    if (stored.rotatedAt) {
      if (now - stored.rotatedAt.getTime() <= JUST_USED_MS) throw justRefreshed();
      await this.endFamily(stored.familyId);
      this.logger.warn(`A refresh token of account ${stored.userId} was presented a second time: its session was ended.`);
      throw refused();
    }

    const next = newToken();
    const claimed = await this.prisma.$transaction(async (tx) => {
      // Only one request gets to use a token, however many present it together.
      const claim = await tx.refreshToken.updateMany({ where: { id: stored.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: new Date(now) } });
      if (claim.count !== 1) return false;
      await tx.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: sha256(next),
          familyId: stored.familyId,
          familyExpiresAt: stored.familyExpiresAt,
          label: stored.label,
          expiresAt: this.tokenExpiry(now, stored.familyExpiresAt),
        },
      });
      return true;
    });
    if (!claimed) {
      // Another request took the token between the look and the claim, or the session was ended.
      const again = await this.prisma.refreshToken.findUnique({ where: { id: stored.id }, select: { revokedAt: true } });
      throw again?.revokedAt ? refused() : justRefreshed();
    }
    return this.answer(stored.user, this.emails.open(stored.user.emailEncrypted, stored.user.id), next, stored.familyId);
  }

  /** End the session a refresh token belongs to, with every token it ever had. */
  async end(refreshToken: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) }, select: { familyId: true } });
    if (stored) await this.endFamily(stored.familyId);
  }

  private async endFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** A token is good until it has not been used for the refresh lifetime, and never past the end of its session. */
  private tokenExpiry(now: number, familyExpiresAt: Date): Date {
    const unused = now + this.config.get('JWT_REFRESH_TTL', { infer: true }) * 1000;
    return new Date(Math.min(unused, familyExpiresAt.getTime()));
  }

  private async answer(user: SessionAccount, email: string, refreshToken: string, sessionId: string): Promise<AuthResponse> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    // Whose it is, and nothing else: whatever a client shows of the account
    // comes from the API, not from inside a token.
    const accessToken = await this.jwt.signAsync(
      { sub: user.id },
      { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), expiresIn: accessTtl, algorithm: TOKEN_ALGORITHM, audience: ACCOUNT_AUDIENCE },
    );
    return {
      user: {
        id: user.id,
        email,
        displayName: user.displayName,
        role: user.role,
        emailVerified: user.emailVerified,
      },
      tokens: { accessToken, refreshToken, expiresIn: accessTtl },
      sessionId,
    };
  }
}

const newToken = (): string => randomBytes(48).toString('hex');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
