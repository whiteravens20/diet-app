// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, race, type TestUser } from '../testing/factories.js';
import { aMailbox, MAIL_ON } from '../testing/mailbox.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { SessionsService } from './sessions.service.js';

const NEW_PASSWORD = 'Another-Passw0rd-1';

describe('the links an account is sent by mail', () => {
  let t: TestApp;
  let auth: AuthService;
  let sessions: SessionsService;
  let users: UsersService;
  let mailbox: ReturnType<typeof aMailbox>;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp(MAIL_ON);
    auth = t.app.get(AuthService);
    sessions = t.app.get(SessionsService);
    users = t.app.get(UsersService);
    mailbox = aMailbox(t);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    // Nothing of the test before is still on its way when the tables are emptied.
    await mailbox.settled();
    await resetDatabase(t.prisma);
    mailbox.sent.length = 0;
    user = await aUser(t);
  });

  /** Ask for a reset of the account's password and return the token of the link that was mailed. */
  const aResetLink = async (): Promise<string> => {
    await auth.requestPasswordReset({ email: user.email });
    return mailbox.tokenFor(user.email);
  };
  /** Ask to change the account's address and return the token of the link mailed to the new one. */
  const aChangeLink = async (to: string, password = user.password): Promise<string> => {
    await users.requestEmailChange(user.id, { newEmail: to, currentPassword: password });
    return mailbox.tokenFor(to);
  };
  const reset = (token: string, password = NEW_PASSWORD) => auth.confirmPasswordReset({ token, password });
  const refusedAs = (error: string) => ({ response: { error } });
  const signsInWith = async (email: string, password: string): Promise<boolean> =>
    auth.login({ email, password }).then(
      () => true,
      () => false,
    );

  describe('a new password', () => {
    it('set by the owner of the account, ends every session of it and is the only one that signs in', async () => {
      await users.changePassword(user.id, { currentPassword: user.password, newPassword: NEW_PASSWORD });

      await expect(sessions.refresh(user.refreshToken)).rejects.toMatchObject(refusedAs('INVALID_REFRESH'));
      expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
      expect(await signsInWith(user.email, user.password)).toBe(false);
    });

    it('set from a link, does the same', async () => {
      await reset(await aResetLink());

      await expect(sessions.refresh(user.refreshToken)).rejects.toMatchObject(refusedAs('INVALID_REFRESH'));
      expect(await signsInWith(user.email, user.password)).toBe(false);
    });

    it('is not set without the present one', async () => {
      await expect(users.changePassword(user.id, { currentPassword: 'Not-The-Passw0rd', newPassword: NEW_PASSWORD })).rejects.toMatchObject(refusedAs('INVALID_PASSWORD'));

      expect(await signsInWith(user.email, user.password)).toBe(true);
      await expect(sessions.refresh(user.refreshToken)).resolves.toBeDefined();
    });
  });

  describe('a link to reset the password', () => {
    it('sets the password once', async () => {
      const link = await aResetLink();

      await reset(link);

      expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
      await expect(reset(link, 'Yet-Another-Passw0rd-2')).rejects.toMatchObject(refusedAs('INVALID_RESET_TOKEN'));
      expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
    });

    it('sets it once even when it is followed twice at the same moment', async () => {
      const link = await aResetLink();

      const results = await race(2, (i) => reset(link, `Raced-Passw0rd-${i}`));

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: refusedAs('INVALID_RESET_TOKEN') });
    });

    it('stops working when another is asked for', async () => {
      const first = await aResetLink();
      const second = await aResetLink();

      await expect(reset(first)).rejects.toMatchObject(refusedAs('INVALID_RESET_TOKEN'));
      await reset(second);
      expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
    });

    it('stops working when the password is changed by its owner', async () => {
      const link = await aResetLink();

      await users.changePassword(user.id, { currentPassword: user.password, newPassword: NEW_PASSWORD });

      await expect(reset(link, 'Yet-Another-Passw0rd-2')).rejects.toMatchObject(refusedAs('INVALID_RESET_TOKEN'));
    });

    it('stops working when the address of the account has changed', async () => {
      const link = await aResetLink();

      await auth.confirmEmailChange(await aChangeLink('moved@example.test'));

      await expect(reset(link)).rejects.toMatchObject(refusedAs('INVALID_RESET_TOKEN'));
    });
  });

  describe('a link to confirm a new address', () => {
    it('moves the account once', async () => {
      const link = await aChangeLink('moved@example.test');

      await auth.confirmEmailChange(link);

      expect(await signsInWith('moved@example.test', user.password)).toBe(true);
      await expect(auth.confirmEmailChange(link)).rejects.toMatchObject(refusedAs('INVALID_EMAIL_CHANGE_TOKEN'));
    });

    it('moves it once even when it is followed twice at the same moment', async () => {
      const link = await aChangeLink('moved@example.test');

      const results = await race(2, () => auth.confirmEmailChange(link));

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('stops working when the password is changed: somebody who knew the old one cannot take the account afterwards', async () => {
      // Whoever had the password asked for the account to be moved to an address of theirs.
      const link = await aChangeLink('taken-over@example.test');

      // The owner notices and changes the password.
      await users.changePassword(user.id, { currentPassword: user.password, newPassword: NEW_PASSWORD });

      await expect(auth.confirmEmailChange(link)).rejects.toMatchObject(refusedAs('INVALID_EMAIL_CHANGE_TOKEN'));
      expect(await signsInWith(user.email, NEW_PASSWORD)).toBe(true);
      expect(await signsInWith('taken-over@example.test', NEW_PASSWORD)).toBe(false);
    });

    it('stops working when the password is reset', async () => {
      const link = await aChangeLink('taken-over@example.test');

      await reset(await aResetLink());

      await expect(auth.confirmEmailChange(link)).rejects.toMatchObject(refusedAs('INVALID_EMAIL_CHANGE_TOKEN'));
    });

    it('stops working when another address is asked for, or the same one again', async () => {
      const first = await aChangeLink('first@example.test');
      const second = await aChangeLink('second@example.test');

      await expect(auth.confirmEmailChange(first)).rejects.toMatchObject(refusedAs('INVALID_EMAIL_CHANGE_TOKEN'));
      await auth.confirmEmailChange(second);
      expect(await signsInWith('second@example.test', user.password)).toBe(true);
    });
  });

  describe('a link to confirm the address of a new account', () => {
    it('confirms it once', async () => {
      const link = await mailbox.tokenFor(user.email);

      await auth.verifyEmail(link);

      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBe(true);
      await expect(auth.verifyEmail(link)).rejects.toMatchObject(refusedAs('INVALID_VERIFICATION_TOKEN'));
    });

    it('is for the address it was sent to: it confirms nothing once the account has moved', async () => {
      const link = await mailbox.tokenFor(user.email);

      await auth.confirmEmailChange(await aChangeLink('moved@example.test'));

      await expect(auth.verifyEmail(link)).rejects.toMatchObject(refusedAs('INVALID_VERIFICATION_TOKEN'));
    });
  });

  describe('an address written in another way', () => {
    const SPELLED = 'Spelled.Out@Example.Test';

    beforeEach(async () => {
      user = await aUser(t, { email: SPELLED });
    });

    it('is the same account for signing in, for a reset and for a change of address', async () => {
      expect(await signsInWith('spelled.out@example.test', user.password)).toBe(true);
      expect(await signsInWith('  SPELLED.OUT@EXAMPLE.TEST ', user.password)).toBe(true);

      // A reset asked for in lower case reaches the account registered in mixed case.
      await auth.requestPasswordReset({ email: 'spelled.out@EXAMPLE.test' });
      await mailbox.settled();
      expect(await t.prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);

      // The account's own address in another case is no new address, and somebody else's is taken.
      await expect(users.requestEmailChange(user.id, { newEmail: 'SPELLED.OUT@example.test', currentPassword: user.password })).rejects.toMatchObject(refusedAs('EMAIL_TAKEN'));
      const other = await aUser(t, { email: 'other@example.test' });
      await expect(users.requestEmailChange(other.id, { newEmail: ' Spelled.Out@Example.TEST', currentPassword: other.password })).rejects.toMatchObject(refusedAs('EMAIL_TAKEN'));

      // And a new address is kept in one form, however it was typed.
      await auth.confirmEmailChange(await aChangeLinkFor(other, 'Moved.Again@Example.Test'));
      expect(await signsInWith('moved.again@example.test', other.password)).toBe(true);
    });

    async function aChangeLinkFor(who: TestUser, to: string): Promise<string> {
      await users.requestEmailChange(who.id, { newEmail: to, currentPassword: who.password });
      return mailbox.tokenFor(to.trim().toLowerCase());
    }
  });
});
