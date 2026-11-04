// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { randomUUID } from 'node:crypto';
import { MAX_OPEN_SESSIONS } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aSession, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { pruneLinks } from './one-time-links.js';
import { SessionsService, USED_TOKENS_KEPT } from './sessions.service.js';

const HOUR = 3_600_000;

describe('what the worker clears away of sessions and links', () => {
  let t: TestApp;
  let sessions: SessionsService;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    sessions = t.app.get(SessionsService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    user = await aUser(t);
  });

  const signIn = () => aSession(t, user);
  const rowsOf = (sessionId: string) =>
    t.prisma.refreshToken.count({ where: { familyId: sessionId } });
  const later = () =>
    t.prisma.refreshToken.updateMany({
      where: { rotatedAt: { not: null } },
      data: { rotatedAt: new Date(Date.now() - 11_000) },
    });

  describe('the tokens of sessions', () => {
    it('go once their session has ended: signed out of, run out, or not used for too long', async () => {
      const signedOut = await signIn();
      const ranOut = await signIn();
      const unused = await signIn();
      await sessions
        .refresh(signedOut.tokens.refreshToken)
        .then((next) => sessions.end(next.tokens.refreshToken));
      await t.prisma.refreshToken.updateMany({
        where: { familyId: ranOut.sessionId },
        data: { familyExpiresAt: new Date(Date.now() - 1000) },
      });
      await t.prisma.refreshToken.updateMany({
        where: { familyId: unused.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect(await sessions.prune()).toBe(4);

      expect(await rowsOf(signedOut.sessionId)).toBe(0);
      expect(await rowsOf(ranOut.sessionId)).toBe(0);
      expect(await rowsOf(unused.sessionId)).toBe(0);
    });

    it('stay while their session is open, the used ones too: a token used twice is still found out afterwards', async () => {
      const open = await signIn();
      const second = (await sessions.refresh(open.tokens.refreshToken)).tokens.refreshToken;
      await later();

      expect(await sessions.prune()).toBe(0);

      expect(await rowsOf(open.sessionId)).toBe(2);
      await expect(sessions.refresh(open.tokens.refreshToken)).rejects.toMatchObject({
        response: { error: 'INVALID_REFRESH' },
      });
      await expect(sessions.refresh(second)).rejects.toMatchObject({
        response: { error: 'INVALID_REFRESH' },
      });
    });

    it('of a session that is open stay the newest used ones: an older one is refused and the session goes on, a newer one presented again ends it', async () => {
      const open = await signIn();
      const used: string[] = [];
      let token = open.tokens.refreshToken;
      for (let n = 0; n < USED_TOKENS_KEPT + 2; n++) {
        used.push(token);
        token = (await sessions.refresh(token)).tokens.refreshToken;
      }
      expect(await rowsOf(open.sessionId)).toBe(USED_TOKENS_KEPT + 1);
      // Out of the ten seconds in which a token used again is taken for a client's second request.
      await t.prisma
        .$executeRaw`UPDATE "RefreshToken" SET "rotatedAt" = "rotatedAt" - INTERVAL '11 seconds' WHERE "rotatedAt" IS NOT NULL`;

      await expect(sessions.refresh(used[0]!)).rejects.toMatchObject({
        response: { error: 'INVALID_REFRESH' },
      });
      token = (await sessions.refresh(token)).tokens.refreshToken;

      await expect(sessions.refresh(used.at(-1)!)).rejects.toMatchObject({
        response: { error: 'INVALID_REFRESH' },
      });
      await expect(sessions.refresh(token)).rejects.toMatchObject({
        response: { error: 'INVALID_REFRESH' },
      });
    });

    it('of an account are open in as many sessions as its list holds: one more ends the one used longest ago', async () => {
      // The session the account was made with is the one used longest ago.
      const made = await t.prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
      const day = new Date(Date.now() + 24 * HOUR);
      await t.prisma.refreshToken.createMany({
        data: Array.from({ length: MAX_OPEN_SESSIONS - 1 }, (_, n) => ({
          userId: user.id,
          tokenHash: `open-${n}`,
          familyId: randomUUID(),
          familyExpiresAt: day,
          expiresAt: day,
          createdAt: new Date(made.createdAt.getTime() + n + 1),
        })),
      });

      const latest = await signIn();

      const open = { userId: user.id, rotatedAt: null, revokedAt: null };
      expect(await t.prisma.refreshToken.count({ where: open })).toBe(MAX_OPEN_SESSIONS);
      expect(
        await t.prisma.refreshToken.count({ where: { ...open, familyId: made.familyId } }),
      ).toBe(0);
      await expect(sessions.refresh(latest.tokens.refreshToken)).resolves.toBeDefined();
    });

    it('of other accounts are left alone', async () => {
      const other = await aUser(t);
      await sessions.endAll(user.id);

      await sessions.prune();

      expect(await t.prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
      expect(await t.prisma.refreshToken.count({ where: { userId: other.id } })).toBe(1);
    });
  });

  describe('the links from mails', () => {
    const row = (expiresAt: Date, usedAt: Date | null, name: string) => ({
      userId: user.id,
      tokenHash: name,
      expiresAt,
      usedAt,
    });
    const soon = () => new Date(Date.now() + HOUR);
    const longAgo = () => new Date(Date.now() - 25 * HOUR);

    it('go once they were used or have run out, and stay while they can still be followed', async () => {
      await t.prisma.passwordResetToken.createMany({
        data: [
          row(soon(), null, 'reset-pending'),
          row(soon(), new Date(), 'reset-used'),
          row(longAgo(), null, 'reset-expired'),
        ],
      });
      await t.prisma.emailVerificationToken.createMany({
        data: [
          row(soon(), null, 'verify-pending'),
          row(soon(), new Date(), 'verify-used'),
          row(longAgo(), null, 'verify-expired'),
        ],
      });
      await t.prisma.emailChangeToken.createMany({
        data: [
          row(soon(), null, 'change-pending'),
          row(soon(), new Date(), 'change-used'),
          row(longAgo(), null, 'change-expired'),
        ].map((data) => ({ ...data, newEmailEncrypted: 'x', newEmailIndex: data.tokenHash })),
      });

      expect(await pruneLinks(t.prisma)).toBe(6);

      expect((await t.prisma.passwordResetToken.findMany()).map((link) => link.tokenHash)).toEqual([
        'reset-pending',
      ]);
      expect(
        (await t.prisma.emailVerificationToken.findMany()).map((link) => link.tokenHash),
      ).toEqual(['verify-pending']);
      expect((await t.prisma.emailChangeToken.findMany()).map((link) => link.tokenHash)).toEqual([
        'change-pending',
      ]);
    });

    it('that ran out a moment ago wait a day, so that nothing is cleared while clocks disagree', async () => {
      await t.prisma.passwordResetToken.create({
        data: row(new Date(Date.now() - 60_000), null, 'just-expired'),
      });

      expect(await pruneLinks(t.prisma)).toBe(0);
    });
  });
});
