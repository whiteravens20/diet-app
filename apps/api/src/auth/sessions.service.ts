// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import type { AccountSession, AuthResponse } from '@diet-app/shared';
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
 * A session as this service hands it out: always with its refresh token.
 * Whether that reaches the client in the answer or in a cookie is for
 * whoever answers the request to say.
 */
export type OpenedSession = AuthResponse & { tokens: { refreshToken: string } };

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

  /**
   * Open a session for an account that has just proved who it is.
   * `secondFactor` says that it did so with the second step as well: the
   * session of an account that has a second factor counts only then.
   */
  async open(user: SessionAccount, email: string, label: string | null = null, { secondFactor = false } = {}): Promise<OpenedSession> {
    const now = Date.now();
    const familyId = randomUUID();
    const familyExpiresAt = new Date(now + this.config.get('JWT_SESSION_TTL', { infer: true }) * 1000);
    const refreshToken = newToken();
    const expiresAt = this.tokenExpiry(now, familyExpiresAt);
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), familyId, familyExpiresAt, label, expiresAt, secondFactorAt: secondFactor ? new Date(now) : null },
    });
    return this.answer(user, email, { refreshToken, expiresAt, now }, familyId);
  }

  /** Exchange a refresh token for the next pair of its session. */
  async refresh(refreshToken: string): Promise<OpenedSession> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: { include: { secondFactor: { select: { id: true } } } } },
    });
    const now = Date.now();
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < now || stored.familyExpiresAt.getTime() < now) throw refused();
    if (stored.user.secondFactor && !stored.secondFactorAt) throw refused();
    if (stored.rotatedAt) {
      if (now - stored.rotatedAt.getTime() <= JUST_USED_MS) throw justRefreshed();
      await this.endFamily(stored.familyId);
      this.logger.warn(`A refresh token of account ${stored.userId} was presented a second time: its session was ended.`);
      throw refused();
    }

    const next = newToken();
    const expiresAt = this.tokenExpiry(now, stored.familyExpiresAt);
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
          secondFactorAt: stored.secondFactorAt,
          expiresAt,
        },
      });
      return true;
    });
    if (!claimed) {
      // Another request took the token between the look and the claim, or the session was ended.
      const again = await this.prisma.refreshToken.findUnique({ where: { id: stored.id }, select: { revokedAt: true } });
      throw again?.revokedAt ? refused() : justRefreshed();
    }
    return this.answer(stored.user, this.emails.open(stored.user.emailEncrypted, stored.user.id), { refreshToken: next, expiresAt, now }, stored.familyId);
  }

  /** End the session a refresh token belongs to, with every token it ever had. */
  async end(refreshToken: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) }, select: { familyId: true } });
    if (stored) await this.endFamily(stored.familyId);
  }

  /**
   * Whether a session of an account is open: begun, not ended, and not past
   * its longest. An access token is good for as long as its session is, and
   * no longer: signing out, a new password, or a refresh token that turned up
   * twice ends what the access tokens of that session can do at once, and an
   * account that was deleted has no session.
   *
   * Where the account has a second factor, the session must have passed it:
   * one that began with the password alone is no session of that account,
   * however it came to be.
   */
  async isOpen(userId: string, sessionId: string): Promise<boolean> {
    const token = await this.prisma.refreshToken.findFirst({
      where: { familyId: sessionId, userId, revokedAt: null, familyExpiresAt: { gt: new Date() }, ...PASSED_THE_SECOND_STEP },
      select: { id: true },
    });
    return token !== null;
  }

  /** The sessions of an account that are open, the one used last first. */
  async list(userId: string): Promise<AccountSession[]> {
    const now = new Date();
    // The token of a session that has not been used yet is where the session stands.
    const open = await this.prisma.refreshToken.findMany({
      where: { userId, rotatedAt: null, revokedAt: null, expiresAt: { gt: now }, familyExpiresAt: { gt: now }, ...PASSED_THE_SECOND_STEP },
      orderBy: { createdAt: 'desc' },
    });
    const began = await this.prisma.refreshToken.groupBy({
      by: ['familyId'],
      where: { familyId: { in: open.map((token) => token.familyId) } },
      _min: { createdAt: true },
    });
    const startOf = new Map(began.map((family) => [family.familyId, family._min.createdAt]));
    return open.map((token) => ({
      id: token.familyId,
      label: token.label,
      startedAt: (startOf.get(token.familyId) ?? token.createdAt).toISOString(),
      lastUsedAt: token.createdAt.toISOString(),
      endsAt: token.familyExpiresAt.toISOString(),
    }));
  }

  /** End one session of an account. */
  async endOne(userId: string, sessionId: string): Promise<void> {
    const ended = await this.prisma.refreshToken.updateMany({ where: { userId, familyId: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (ended.count === 0) throw new NotFoundException({ error: 'SESSION_NOT_FOUND', message: 'That session is not open.' });
  }

  /** End every session of an account: it is signed out everywhere. */
  async endAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /**
   * Remove the tokens of sessions that have ended: signed out of, run out, or
   * not used for the refresh lifetime. The used tokens of a session that is
   * open stay, so that one presented a second time is still found out.
   * Returns how many were removed.
   */
  async prune(): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM "RefreshToken" token
      WHERE NOT EXISTS (
        SELECT 1 FROM "RefreshToken" usable
        WHERE usable."familyId" = token."familyId"
          AND usable."rotatedAt" IS NULL AND usable."revokedAt" IS NULL
          AND usable."expiresAt" > NOW() AND usable."familyExpiresAt" > NOW()
      )`;
  }

  private async endFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** A token is good until it has not been used for the refresh lifetime, and never past the end of its session. */
  private tokenExpiry(now: number, familyExpiresAt: Date): Date {
    const unused = now + this.config.get('JWT_REFRESH_TTL', { infer: true }) * 1000;
    return new Date(Math.min(unused, familyExpiresAt.getTime()));
  }

  private async answer(
    user: SessionAccount,
    email: string,
    refresh: { refreshToken: string; expiresAt: Date; now: number },
    sessionId: string,
  ): Promise<OpenedSession> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    // Whose it is and of which session, and nothing else: whatever a client
    // shows of the account comes from the API, not from inside a token.
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId },
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
      tokens: { accessToken, refreshToken: refresh.refreshToken, expiresIn: accessTtl, refreshExpiresIn: Math.round((refresh.expiresAt.getTime() - refresh.now) / 1000) },
      sessionId,
    };
  }
}

/** For a query of tokens: of an account without a second factor, or of a session that passed it. */
const PASSED_THE_SECOND_STEP = { OR: [{ secondFactorAt: { not: null } }, { user: { secondFactor: { is: null } } }] } satisfies Prisma.RefreshTokenWhereInput;

const newToken = (): string => randomBytes(48).toString('hex');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
