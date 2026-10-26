// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, type TestUser } from '../testing/factories.js';
import { aMailbox, MAIL_ON } from '../testing/mailbox.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AuthService } from './auth.service.js';

describe('what a request answers, whatever the mail server does', () => {
  let t: TestApp;
  let auth: AuthService;
  let mailbox: ReturnType<typeof aMailbox>;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp(MAIL_ON);
    auth = t.app.get(AuthService);
    mailbox = aMailbox(t);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    mailbox.working();
    await mailbox.settled();
    await resetDatabase(t.prisma);
    mailbox.sent.length = 0;
    user = await aUser(t);
    await mailbox.settled();
    mailbox.sent.length = 0;
  });

  describe('with a mail server that is down', () => {
    beforeEach(() => mailbox.failing());

    it('makes the account all the same, and says so', async () => {
      const made = await t
        .http()
        .post('/api/auth/register')
        .send({ email: 'new@example.test', password: 'Brand-New-Passw0rd', displayName: 'New' });

      expect(made.status).toBe(201);
      expect(made.body.user).toMatchObject({ email: 'new@example.test', emailVerified: false });
      // The address is not taken by half an account: the same request again says it is registered.
      expect(
        (
          await t
            .http()
            .post('/api/auth/register')
            .send({ email: 'new@example.test', password: 'Brand-New-Passw0rd', displayName: 'New' })
        ).body.error,
      ).toBe('EMAIL_TAKEN');
    });

    it('accepts a request to reset a password alike for an address with an account and for one without', async () => {
      const known = await t
        .http()
        .post('/api/auth/password-reset/request')
        .send({ email: user.email });
      const unknown = await t
        .http()
        .post('/api/auth/password-reset/request')
        .send({ email: 'nobody@example.test' });

      expect([known.status, known.text]).toEqual([202, '']);
      expect([unknown.status, unknown.text]).toEqual([202, '']);
    });

    it('accepts a request to change the address, and keeps the link ready', async () => {
      await t
        .http()
        .post('/api/users/me/email')
        .set(as(user))
        .send({ newEmail: 'moved@example.test', currentPassword: user.password })
        .expect(202);

      await mailbox.settled();
      expect(
        await t.prisma.emailChangeToken.count({ where: { userId: user.id, usedAt: null } }),
      ).toBe(1);
    });

    it('changes a password although the notice cannot go out', async () => {
      await t
        .http()
        .post('/api/users/me/password')
        .set(as(user))
        .send({ currentPassword: user.password, newPassword: 'Another-Passw0rd-1' })
        .expect(204);

      await expect(
        auth.login({ email: user.email, password: 'Another-Passw0rd-1' }),
      ).resolves.toBeDefined();
    });
  });

  describe('with a mail server that takes its time', () => {
    it('answers a request to reset a password before anything is looked up or sent', async () => {
      const release = mailbox.holding();

      await auth.requestPasswordReset({ email: user.email });

      // The answer is given; the mail is still with the server.
      expect(mailbox.sent).toEqual([]);
      release();
      expect(await mailbox.to(user.email)).toHaveLength(1);
      expect(await t.prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
    });

    it('does nothing more for an address without an account, and answers the same', async () => {
      await expect(
        auth.requestPasswordReset({ email: 'nobody@example.test' }),
      ).resolves.toBeUndefined();

      await mailbox.settled();
      expect(mailbox.sent).toEqual([]);
      expect(await t.prisma.passwordResetToken.count()).toBe(0);
    });
  });
});
