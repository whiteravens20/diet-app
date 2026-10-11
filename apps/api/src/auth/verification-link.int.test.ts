// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, type TestUser } from '../testing/factories.js';
import { aMailbox, MAIL_ON } from '../testing/mailbox.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AuthService } from './auth.service.js';

const MINUTE = 60_000;

describe('the link that confirms the address of an account, asked for again', () => {
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
    await mailbox.settled();
    await resetDatabase(t.prisma);
    mailbox.sent.length = 0;
    user = await aUser(t);
    await mailbox.settled();
  });

  const again = () => t.http().post('/api/users/me/email/resend-verification').set(as(user));
  /** Pretend the last mail went out `minutes` ago. */
  const sentAgo = (minutes: number) => t.prisma.emailVerificationToken.updateMany({ where: { userId: user.id }, data: { lastSentAt: new Date(Date.now() - minutes * MINUTE) } });
  const links = async (): Promise<string[]> => (await mailbox.to(user.email)).map((mail) => /token=([0-9a-f]+)/.exec(mail.text)![1]!);

  it('is sent once when the account is made, which starts unconfirmed', async () => {
    expect(await links()).toHaveLength(1);
    expect((await mailbox.to(user.email))[0]!.subject).toBe('Confirm your Diet App email address');
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBe(false);
  });

  it('is not sent again within two minutes of the last one, and the answer says how long to wait', async () => {
    const refused = await again();

    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('VERIFICATION_SENT_RECENTLY');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(100);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(120);
    expect(await links()).toHaveLength(1);
  });

  it('is the same link when it is sent again, so that either mail works, once', async () => {
    await sentAgo(3);

    await again().expect(202);

    const [first, second] = await links();
    expect(second).toBe(first);
    expect(await t.prisma.emailVerificationToken.count({ where: { userId: user.id } })).toBe(1);
    await auth.verifyEmail(first!);
    await expect(auth.verifyEmail(second!)).rejects.toMatchObject({ response: { error: 'INVALID_VERIFICATION_TOKEN' } });
  });

  it('counts the wait from the mail that was sent last', async () => {
    await sentAgo(3);
    await again().expect(202);

    expect((await again()).status).toBe(429);
  });

  it('is a new link once the one before has little time left, and that one stops working', async () => {
    await t.prisma.emailVerificationToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() + 5 * MINUTE), lastSentAt: new Date(Date.now() - 55 * MINUTE) } });

    await again().expect(202);

    const [first, second] = await links();
    expect(second).not.toBe(first);
    await expect(auth.verifyEmail(first!)).rejects.toMatchObject({ response: { error: 'INVALID_VERIFICATION_TOKEN' } });
    await auth.verifyEmail(second!);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBe(true);
  });

  it('is a new link where the one before was made before links could be sent again', async () => {
    // A row whose token nobody can work out from it: as every row was until now.
    await t.prisma.emailVerificationToken.updateMany({ where: { userId: user.id }, data: { tokenHash: createHash('sha256').update('a-token-of-old').digest('hex'), lastSentAt: new Date(Date.now() - 3 * MINUTE) } });

    await again().expect(202);

    const second = (await links()).at(-1)!;
    await expect(auth.verifyEmail('a-token-of-old')).rejects.toMatchObject({ response: { error: 'INVALID_VERIFICATION_TOKEN' } });
    await auth.verifyEmail(second);
  });

  it('is kept as a hash: the database holds nothing a link can be made from without the application', async () => {
    const [link] = await links();
    const [row] = await t.prisma.emailVerificationToken.findMany({ where: { userId: user.id } });

    expect(row!.tokenHash).toBe(createHash('sha256').update(link!).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(link);
  });

  it('is not sent for an address that is confirmed', async () => {
    await auth.verifyEmail((await links())[0]!);

    expect((await again().expect(400)).body.error).toBe('EMAIL_ALREADY_VERIFIED');
  });
});
