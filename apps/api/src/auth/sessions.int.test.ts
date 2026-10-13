// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aSession, aUser, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { SessionsService, type OpenedSession } from './sessions.service.js';

const DAY = 86_400_000;

describe('the session of an account', () => {
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

  const refusedAs = (error: string) => ({ response: { error } });
  const refresh = (token: string) => sessions.refresh(token);
  /** Sign in again: a second session of the same account. */
  const signIn = (): Promise<OpenedSession> => aSession(t, user);
  /** Let the moment in which a token was just used go by. */
  const later = () => t.prisma.refreshToken.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 11_000) } });
  const works = async (token: string): Promise<boolean> =>
    refresh(token).then(
      () => true,
      () => false,
    );

  describe('a refresh token', () => {
    it('is given for the next one once, and the session goes on with that', async () => {
      const second = (await refresh(user.refreshToken)).tokens.refreshToken;
      const third = (await refresh(second)).tokens.refreshToken;

      expect(new Set([user.refreshToken, second, third]).size).toBe(3);
      expect(await works(third)).toBe(true);
    });

    it('used a second time ends the whole session: the token that came after it stops working too', async () => {
      const second = (await refresh(user.refreshToken)).tokens.refreshToken;
      await later();

      await expect(refresh(user.refreshToken)).rejects.toMatchObject(refusedAs('INVALID_REFRESH'));

      expect(await works(second)).toBe(false);
    });

    it('that was copied is of no use once the owner has gone on, and using it ends the session it was copied from', async () => {
      const stolen = user.refreshToken;
      const owners = (await refresh(user.refreshToken)).tokens.refreshToken;
      await later();

      // Whoever copied the token tries it.
      expect(await works(stolen)).toBe(false);
      // The owner is signed out, which is how they learn of it; nobody holds a token that works.
      expect(await works(owners)).toBe(false);
    });

    it('that was copied and used first is found out when the owner comes back, however far the thief has gone on by then', async () => {
      const owners = user.refreshToken;
      let thiefs = (await refresh(user.refreshToken)).tokens.refreshToken;
      await later();
      thiefs = (await refresh(thiefs)).tokens.refreshToken;
      await later();
      thiefs = (await refresh(thiefs)).tokens.refreshToken;
      await later();

      await expect(refresh(owners)).rejects.toMatchObject(refusedAs('INVALID_REFRESH'));

      expect(await works(thiefs)).toBe(false);
    });

    it('used twice within a moment is two tabs, not a theft: the second is told so, and the session lives', async () => {
      const second = (await refresh(user.refreshToken)).tokens.refreshToken;

      await expect(refresh(user.refreshToken)).rejects.toMatchObject({ status: 409, response: { error: 'SESSION_JUST_REFRESHED' } });

      expect(await works(second)).toBe(true);
    });

    it('presented by two requests at the same moment goes on as one session', async () => {
      const results = await race(2, () => refresh(user.refreshToken));

      const won = results.filter((result) => result.status === 'fulfilled');
      expect(won).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: refusedAs('SESSION_JUST_REFRESHED') });
      // One token of the session works, and it is the one that was handed out.
      expect(await t.prisma.refreshToken.count({ where: { userId: user.id, rotatedAt: null, revokedAt: null } })).toBe(1);
      expect(await works((won[0] as PromiseFulfilledResult<OpenedSession>).value.tokens.refreshToken)).toBe(true);
    });

    it('that nobody was given is refused, and ends nothing', async () => {
      await expect(refresh('f'.repeat(96))).rejects.toMatchObject(refusedAs('INVALID_REFRESH'));

      expect(await works(user.refreshToken)).toBe(true);
    });
  });

  describe('a session', () => {
    it('says which one it is, and keeps being that one as it goes on', async () => {
      const opened = await signIn();
      const refreshed = await refresh(opened.tokens.refreshToken);

      expect(opened.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(refreshed.sessionId).toBe(opened.sessionId);
      expect((await signIn()).sessionId).not.toBe(opened.sessionId);
    });

    it('ends when it has lasted its longest, however often it was used', async () => {
      const opened = await signIn();
      const row = await t.prisma.refreshToken.findFirstOrThrow({ where: { familyId: opened.sessionId } });
      // Ninety days from when it began, by default.
      expect(Math.round((row.familyExpiresAt.getTime() - row.createdAt.getTime()) / DAY)).toBe(90);

      // On its last day, a token is good for no longer than the session.
      const lastDay = new Date(Date.now() + DAY / 2);
      await t.prisma.refreshToken.updateMany({ where: { familyId: opened.sessionId }, data: { familyExpiresAt: lastDay } });
      const next = await refresh(opened.tokens.refreshToken);
      const nextRow = await t.prisma.refreshToken.findFirstOrThrow({ where: { familyId: opened.sessionId, rotatedAt: null } });
      expect(nextRow.expiresAt.getTime()).toBe(lastDay.getTime());

      // And after it, none is good.
      await t.prisma.refreshToken.updateMany({ where: { familyId: opened.sessionId }, data: { familyExpiresAt: new Date(Date.now() - 1000) } });
      await expect(refresh(next.tokens.refreshToken)).rejects.toMatchObject(refusedAs('INVALID_REFRESH'));
    });

    it('ends when it is signed out of, with every token it ever had', async () => {
      const first = (await signIn()).tokens.refreshToken;
      const second = (await refresh(first)).tokens.refreshToken;

      await sessions.end(second);
      await later();

      expect(await works(second)).toBe(false);
      expect(await works(first)).toBe(false);
    });

    it('is one of several: what ends one leaves the others', async () => {
      const laptop = await signIn();
      const phone = await signIn();
      const next = (await refresh(laptop.tokens.refreshToken)).tokens.refreshToken;
      await later();

      // The laptop's session is ended by a token used twice; the phone's is signed out of.
      await refresh(laptop.tokens.refreshToken).catch(() => undefined);
      expect(await works(next)).toBe(false);
      expect(await works(phone.tokens.refreshToken)).toBe(true);
      expect(await works(user.refreshToken)).toBe(true);
    });
  });
});
