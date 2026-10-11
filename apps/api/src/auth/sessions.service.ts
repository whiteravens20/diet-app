// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
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
 * The sessions of accounts: a short-lived access token that says who calls,
 * and a refresh token that gets the next one. A refresh token is random, is
 * kept as a hash, and is replaced each time it is used.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly emails: AccountEmail,
  ) {}

  /** Open a session for an account that has just proved who it is. */
  async open(user: SessionAccount, email: string): Promise<AuthResponse> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });

    // Whose it is, and nothing else: whatever a client shows of the account
    // comes from the API, not from inside a token.
    const accessToken = await this.jwt.signAsync(
      { sub: user.id },
      { secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }), expiresIn: accessTtl, algorithm: TOKEN_ALGORITHM, audience: ACCOUNT_AUDIENCE },
    );
    const refreshToken = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    return {
      user: {
        id: user.id,
        email,
        displayName: user.displayName,
        role: user.role,
        emailVerified: user.emailVerified,
      },
      tokens: { accessToken, refreshToken, expiresIn: accessTtl },
    };
  }

  /** Exchange a refresh token for a new pair. */
  async refresh(refreshToken: string): Promise<AuthResponse> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException({ error: 'INVALID_REFRESH', message: 'Refresh token rejected.' });
    }
    // Rotate: revoke the used token, issue a fresh pair.
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.open(stored.user, this.emails.open(stored.user.emailEncrypted, stored.user.id));
  }

  /** End the session a refresh token belongs to. */
  async end(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken
      .updateMany({ where: { tokenHash: sha256(refreshToken) }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
