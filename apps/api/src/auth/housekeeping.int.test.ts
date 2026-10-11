// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AuthService } from './auth.service.js';
import { pruneLinks } from './one-time-links.js';
import { SessionsService } from './sessions.service.js';

const HOUR = 3_600_000;

describe('what the worker clears away of sessions and links', () => {
  let t: TestApp;
  let auth: AuthService;
  let sessions: SessionsService;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    auth = t.app.get(AuthService);
    sessions = t.app.get(SessionsService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    user = await aUser(t);
  });

  const signIn = () => auth.login({ email: user.email, password: user.password });
  const rowsOf = (sessionId: string) => t.prisma.refreshToken.count({ where: { familyId: sessionId } });
  const later = () => t.prisma.refreshToken.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 11_000) } });

  describe('the tokens of sessions', () => {
    it('go once their session has ended: signed out of, run out, or not used for too long', async () => {
      const signedOut = await signIn();
      const ranOut = await signIn();
      const unused = await signIn();
      await sessions.refresh(signedOut.tokens.refreshToken).then((next) => sessions.end(next.tokens.refreshToken));
      await t.prisma.refreshToken.updateMany({ where: { familyId: ranOut.sessionId }, data: { familyExpiresAt: new Date(Date.now() - 1000) } });
      await t.prisma.refreshToken.updateMany({ where: { familyId: unused.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });

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
      await expect(sessions.refresh(open.tokens.refreshToken)).rejects.toMatchObject({ response: { error: 'INVALID_REFRESH' } });
      await expect(sessions.refresh(second)).rejects.toMatchObject({ response: { error: 'INVALID_REFRESH' } });
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
    const row = (expiresAt: Date, usedAt: Date | null, name: string) => ({ userId: user.id, tokenHash: name, expiresAt, usedAt });
    const soon = () => new Date(Date.now() + HOUR);
    const longAgo = () => new Date(Date.now() - 25 * HOUR);

    it('go once they were used or have run out, and stay while they can still be followed', async () => {
      await t.prisma.passwordResetToken.createMany({ data: [row(soon(), null, 'reset-pending'), row(soon(), new Date(), 'reset-used'), row(longAgo(), null, 'reset-expired')] });
      await t.prisma.emailVerificationToken.createMany({ data: [row(soon(), null, 'verify-pending'), row(soon(), new Date(), 'verify-used'), row(longAgo(), null, 'verify-expired')] });
      await t.prisma.emailChangeToken.createMany({
        data: [row(soon(), null, 'change-pending'), row(soon(), new Date(), 'change-used'), row(longAgo(), null, 'change-expired')].map((data) => ({ ...data, newEmailEncrypted: 'x', newEmailIndex: data.tokenHash })),
      });

      expect(await pruneLinks(t.prisma)).toBe(6);

      expect((await t.prisma.passwordResetToken.findMany()).map((link) => link.tokenHash)).toEqual(['reset-pending']);
      expect((await t.prisma.emailVerificationToken.findMany()).map((link) => link.tokenHash)).toEqual(['verify-pending']);
      expect((await t.prisma.emailChangeToken.findMany()).map((link) => link.tokenHash)).toEqual(['change-pending']);
    });

    it('that ran out a moment ago wait a day, so that nothing is cleared while clocks disagree', async () => {
      await t.prisma.passwordResetToken.create({ data: row(new Date(Date.now() - 60_000), null, 'just-expired') });

      expect(await pruneLinks(t.prisma)).toBe(0);
    });
  });
});
