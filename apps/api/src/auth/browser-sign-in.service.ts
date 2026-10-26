// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash, randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import type { BrowserCode, BrowserCodeAccount } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountEmail } from './account-email.js';
import { type OpenedSession, SessionsService } from './sessions.service.js';

/** How long a code is good for. */
const CODE_SECONDS = 60;

/** How long the session of a browser signed in with a code lasts. The application signs it in again whenever it opens it. */
const BROWSER_SESSION_SECONDS = 86_400;

/** The most codes one account may ask for in an hour, from all its sessions together. */
const MOST_CODES_AN_HOUR = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const refused = (): UnauthorizedException =>
  new UnauthorizedException({
    error: 'INVALID_BROWSER_CODE',
    message: 'The code is not good: used, run out, or never given.',
  });

/**
 * An application signs a browser in to its account: it asks for a code with
 * the refresh token of its session, and the web application's page that the
 * browser opens trades the code for a session of the browser's own.
 *
 * Only a refresh token buys a code, never an access token: an access token
 * that got away is good for minutes, and must not become a session that
 * lasts. The code is good for a minute and once, is kept as a hash, and
 * travels in the fragment of an address, which no server and no `Referer`
 * is given. The page shows whose account the code is for and uses it only
 * when its reader says so: a code somebody sent in a link signs nobody in
 * to the sender's account unawares. The browser's session lasts a day and
 * takes the place of the one the browser had, whoever's that was.
 */
@Injectable()
export class BrowserSignIn {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly emails: AccountEmail,
  ) {}

  /** A code for the account of `refreshToken`'s session, with the session's next pair: the token is used up as a refresh uses it. */
  async codeFor(refreshToken: string): Promise<BrowserCode & OpenedSession> {
    const code = randomBytes(32).toString('hex');
    const opened = await this.sessions.refresh(refreshToken, async (tx, { userId, sessionId }) => {
      const now = Date.now();
      const lastHour = await tx.browserSignInCode.count({
        where: { userId, createdAt: { gt: new Date(now - HOUR_MS) } },
      });
      if (lastHour >= MOST_CODES_AN_HOUR) {
        throw new HttpException(
          {
            error: 'BROWSER_CODES_USED_UP',
            message: `One account may sign a browser in at most ${MOST_CODES_AN_HOUR} times in an hour.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await tx.browserSignInCode.create({
        data: {
          userId,
          sessionId,
          codeHash: sha256(code),
          expiresAt: new Date(now + CODE_SECONDS * 1000),
        },
      });
    });
    return { ...opened, code, codeExpiresIn: CODE_SECONDS };
  }

  /**
   * The account `code` would sign a browser in to, without using the code: a
   * link with somebody else's code shows whose it is before anything is
   * signed in.
   */
  async accountOf(code: string): Promise<BrowserCodeAccount> {
    const { user } = await this.usable(code, new Date());
    return { email: this.emails.open(user.emailEncrypted, user.id), displayName: user.displayName };
  }

  /**
   * A session of a browser for the account of `code`, while the session that
   * asked for it is open. `replacing` is the refresh token of the session the
   * browser had: it ends.
   */
  async signIn(
    code: string,
    replacing: string | undefined,
    label: string | null,
  ): Promise<OpenedSession> {
    const now = new Date();
    const found = await this.usable(code, now);
    // Only one request gets to use a code, however many present it together.
    const used = await this.prisma.browserSignInCode.updateMany({
      where: { id: found.id, usedAt: null },
      data: { usedAt: now },
    });
    if (used.count !== 1) throw refused();

    if (replacing) await this.sessions.end(replacing);
    const { user } = found;
    // The session that asked passed the second step where the account has one: this one comes of it.
    return this.sessions.open(user, this.emails.open(user.emailEncrypted, user.id), label, {
      secondFactor: user.secondFactor !== null,
      lastsSeconds: BROWSER_SESSION_SECONDS,
    });
  }

  /** A code that is not used, not run out, and of a session that is still open: one signed out of, or ended by a new password, in the minute since signs nobody in. */
  private async usable(code: string, now: Date) {
    const found = await this.prisma.browserSignInCode.findUnique({
      where: { codeHash: sha256(code) },
      include: { user: { include: { secondFactor: { select: { id: true } } } } },
    });
    if (!found || found.usedAt || found.expiresAt <= now) throw refused();
    if (!(await this.sessions.isOpen(found.userId, found.sessionId))) throw refused();
    return found;
  }

  /** Remove the codes of more than a day ago: an hour's count no longer takes them in. Returns how many were removed. */
  async prune(): Promise<number> {
    const { count } = await this.prisma.browserSignInCode.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - DAY_MS) } },
    });
    return count;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
