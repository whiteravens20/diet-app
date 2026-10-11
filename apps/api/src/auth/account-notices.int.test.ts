// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, type TestUser } from '../testing/factories.js';
import { aMailbox, MAIL_ON } from '../testing/mailbox.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';

const NEW = 'moved@example.test';

describe('what the holder of an account is told when its credentials change', () => {
  let t: TestApp;
  let auth: AuthService;
  let users: UsersService;
  let mailbox: ReturnType<typeof aMailbox>;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp(MAIL_ON);
    auth = t.app.get(AuthService);
    users = t.app.get(UsersService);
    mailbox = aMailbox(t);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await mailbox.settled();
    await resetDatabase(t.prisma);
    user = await aUser(t);
    await mailbox.settled();
    mailbox.sent.length = 0;
  });

  const subjects = async (address: string): Promise<string[]> => (await mailbox.to(address)).map((mail) => mail.subject);

  describe('when a change of its address is asked for', () => {
    beforeEach(() => users.requestEmailChange(user.id, { newEmail: NEW, currentPassword: user.password }));

    it('the address it has is told, with enough of the new one to know it by and no way to act on the request', async () => {
      const [notice] = await mailbox.to(user.email);

      expect(notice!.subject).toBe('A change of your Diet App email address was requested');
      expect(notice!.text).toContain('m•••@example.test');
      expect(notice!.text).not.toContain(NEW);
      expect(notice!.text).not.toMatch(/token=|https?:/);
      expect(notice!.text).toContain('change your password');
    });

    it('the new address gets the link, and nothing else', async () => {
      expect(await subjects(NEW)).toEqual(['Confirm your new Diet App email address']);
    });

    it('and what the notice says is true: changing the password ends the request', async () => {
      const link = await mailbox.tokenFor(NEW);

      await users.changePassword(user.id, { currentPassword: user.password, newPassword: 'Another-Passw0rd-1' });

      await expect(auth.confirmEmailChange(link)).rejects.toMatchObject({ response: { error: 'INVALID_EMAIL_CHANGE_TOKEN' } });
    });
  });

  it('when its address has changed, the address it had is told', async () => {
    await users.requestEmailChange(user.id, { newEmail: NEW, currentPassword: user.password });
    await auth.confirmEmailChange(await mailbox.tokenFor(NEW));

    const last = (await mailbox.to(user.email)).at(-1)!;
    expect(last.subject).toBe('Your Diet App email address was changed');
    expect(last.text).toContain('m•••@example.test');
    // The new address is told nothing more: whoever confirmed it knows.
    expect(await subjects(NEW)).toEqual(['Confirm your new Diet App email address']);
  });

  it('when its password is set from a reset link, its address is told', async () => {
    await auth.requestPasswordReset({ email: user.email });
    await auth.confirmPasswordReset({ token: await mailbox.tokenFor(user.email), password: 'Another-Passw0rd-1' });

    expect(await subjects(user.email)).toEqual(['Reset your Diet App password', 'Your Diet App password was changed']);
  });

  it('when its password is changed by its holder, its address is told', async () => {
    await users.changePassword(user.id, { currentPassword: user.password, newPassword: 'Another-Passw0rd-1' });

    expect(await subjects(user.email)).toEqual(['Your Diet App password was changed']);
  });

  it('in the language of the account', async () => {
    await t.prisma.user.update({ where: { id: user.id }, data: { locale: 'pl' } });

    await users.requestEmailChange(user.id, { newEmail: NEW, currentPassword: user.password });
    await auth.confirmEmailChange(await mailbox.tokenFor(NEW));

    expect(await subjects(user.email)).toEqual(['Poproszono o zmianę adresu e-mail w Diet App', 'Adres e-mail w Diet App został zmieniony']);
  });

  describe('a part of an address that is enough to know it by', () => {
    it.each([
      ['moved@example.test', 'm•••@example.test'],
      ['a@example.test', 'a•••@example.test'],
      ['Anna.Kowalska@Poczta.Example', 'A•••@Poczta.Example'],
    ])('%s is shown as %s', async (address, shown) => {
      const { partOf } = await import('../mail/mail-templates.js');
      expect(partOf(address)).toBe(shown);
    });
  });
});
