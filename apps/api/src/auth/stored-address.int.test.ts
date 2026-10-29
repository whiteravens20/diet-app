// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, type TestUser } from '../testing/factories.js';
import { aMailbox, MAIL_ON } from '../testing/mailbox.js';
import { ciphertextWrittenBefore } from '../testing/old-ciphertext.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { deriveKey } from '../common/crypto.js';
import { AccountEmail } from './account-email.js';

describe('the address of an account, as the database holds it', () => {
  let t: TestApp;
  let emails: AccountEmail;
  let mailbox: ReturnType<typeof aMailbox>;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp(MAIL_ON);
    emails = t.app.get(AccountEmail);
    mailbox = aMailbox(t);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await mailbox.settled();
    await resetDatabase(t.prisma);
    user = await aUser(t);
  });

  const stored = async (id: string): Promise<string> =>
    (await t.prisma.user.findUniqueOrThrow({ where: { id } })).emailEncrypted;
  const me = (who: TestUser) => t.http().get('/api/users/me').set(as(who));

  it('is a ciphertext sealed for that account, and reads back as the address', async () => {
    const sealed = await stored(user.id);

    expect(sealed).toMatch(/^v2:/);
    expect(sealed).not.toContain(user.email);
    expect(emails.open(sealed, user.id)).toBe(user.email);
    expect((await me(user).expect(200)).body.email).toBe(user.email);
  });

  it('does not open in the row of another account', async () => {
    const other = await aUser(t);
    const sealed = await stored(user.id);

    expect(() => emails.open(sealed, other.id)).toThrow();
  });

  it('does not open in the form from before addresses were sealed for their account', () => {
    const key = deriveKey('b2'.repeat(32), 'email-encryption');

    expect(() => emails.open(ciphertextWrittenBefore(user.email, key), user.id)).toThrow(
      'malformed ciphertext',
    );
  });

  describe('an address the account asked to change to', () => {
    const NEW = 'moved@example.test';

    beforeEach(async () => {
      await t
        .http()
        .post('/api/users/me/email')
        .set(as(user))
        .send({ newEmail: NEW, currentPassword: user.password })
        .expect(202);
    });

    it('waits as another kind of value than the address of the account', async () => {
      const token = await t.prisma.emailChangeToken.findFirstOrThrow({
        where: { userId: user.id },
      });

      expect(token.newEmailEncrypted).toMatch(/^v2:/);
      expect(emails.openPending(token.newEmailEncrypted, user.id)).toBe(NEW);
      // Put into the account's row as it is, it would not open there.
      expect(() => emails.open(token.newEmailEncrypted, user.id)).toThrow();
    });

    it('becomes the address of the account when the link is followed', async () => {
      await t
        .http()
        .post('/api/auth/confirm-email-change')
        .send({ token: await mailbox.tokenFor(NEW) })
        .expect(204);

      expect(emails.open(await stored(user.id), user.id)).toBe(NEW);
      const again = await t
        .http()
        .post('/api/auth/login')
        .send({ email: NEW, password: user.password })
        .expect(200);
      expect(again.body.user.email).toBe(NEW);
    });
  });
});
