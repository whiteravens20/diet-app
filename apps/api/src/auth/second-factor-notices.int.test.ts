// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { SecondFactorChallenge } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aSecondFactor, anAuthenticator, type Authenticator } from '../testing/authenticator.js';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, asAdmin, type TestUser } from '../testing/factories.js';
import { aMailbox, MAIL_ON } from '../testing/mailbox.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AuthService } from './auth.service.js';

describe('what an account is told about its second factor', () => {
  let t: TestApp;
  let auth: AuthService;
  let mailbox: ReturnType<typeof aMailbox>;
  let app: Authenticator;
  let user: TestUser;
  let secret: string;
  let recoveryCodes: string[];

  beforeAll(async () => {
    t = await createTestApp(MAIL_ON);
    auth = t.app.get(AuthService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    mailbox = aMailbox(t);
    app = anAuthenticator(t);
    user = await aUser(t);
    ({ secret, recoveryCodes } = await aSecondFactor(t, user, app));
  });

  /** The subjects of the mails `user` was sent since the one that told it of the set-up. */
  const told = async (): Promise<string[]> => (await mailbox.to(user.email)).map((mail) => mail.subject).slice(2);
  const challenged = async (): Promise<string> => ((await auth.login({ email: user.email, password: user.password })) as SecondFactorChallenge).secondFactor.challenge;
  const answered = async (code: string): Promise<void> => void (await auth.finishLogin({ challenge: await challenged(), code }).catch(() => undefined));

  it('that it was switched on, and that every other session ended', async () => {
    const [verification, notice] = await mailbox.to(user.email);

    expect(verification!.subject).toMatch(/confirm|verify/i);
    expect(notice!.subject).toBe('Two-step sign-in was switched on for your Diet App account');
    expect(notice!.text).toContain('Every other session was signed out.');
  });

  it('that it was switched off, when the holder did that', async () => {
    await t.http().delete('/api/users/me/second-factor').set(as(user)).send({ currentPassword: user.password, code: app.code(secret) }).expect(204);

    const [notice] = (await mailbox.to(user.email)).slice(2);
    expect(notice!.subject).toBe('Two-step sign-in was switched off for your Diet App account');
    expect(notice!.text).toContain('signing in takes only your password again');
    expect(notice!.text).not.toContain('operator of your instance switched');
  });

  it('that the operator switched it off, when the operator did', async () => {
    await t.http().delete('/api/admin/accounts/second-factor').set(asAdmin).send({ email: user.email }).expect(204);

    const [notice] = (await mailbox.to(user.email)).slice(2);
    expect(notice!.text).toContain('The operator of your instance switched two-step sign-in off');
  });

  it('that a recovery code was used, and how many are left', async () => {
    await answered(recoveryCodes[0]!);
    await answered(recoveryCodes[1]!);

    const notices = (await mailbox.to(user.email)).slice(2);
    expect(notices.map((mail) => mail.subject)).toEqual(Array(2).fill('A recovery code of your Diet App account was used'));
    expect(notices[0]!.text).toContain('Recovery codes left: 9.');
    expect(notices[1]!.text).toContain('Recovery codes left: 8.');
  });

  it('not of a sign-in with a code from the app', async () => {
    await answered(app.code(secret));

    expect(await told()).toEqual([]);
  });

  it('that somebody who knows the password got the code wrong five times, once', async () => {
    for (let n = 0; n < 4; n += 1) await answered(app.wrongCode(secret));
    expect(await told()).toEqual([]);

    await answered(app.wrongCode(secret));
    expect(await told()).toEqual(['Wrong sign-in codes were entered for your Diet App account']);

    // Codes that have to wait, and the wrong ones after the wait, tell nothing more.
    await answered(app.wrongCode(secret));
    app.wait(60);
    await answered(app.wrongCode(secret));
    expect(await told()).toHaveLength(1);
  });

  it('in the language of the account', async () => {
    await t.prisma.user.update({ where: { id: user.id }, data: { locale: 'pl' } });

    await answered(recoveryCodes[0]!);

    const [notice] = (await mailbox.to(user.email)).slice(2);
    expect(notice!.subject).toBe('Użyto kodu zapasowego Twojego konta w Diet App');
    expect(notice!.text).toContain('Pozostałe kody zapasowe: 9.');
  });

  it('with nothing in a mail that signs anybody in', async () => {
    await answered(recoveryCodes[0]!);
    for (let n = 0; n < 5; n += 1) await answered(app.wrongCode(secret));
    await t.http().delete('/api/admin/accounts/second-factor').set(asAdmin).send({ email: user.email }).expect(204);

    const everything = (await mailbox.to(user.email)).slice(1).map((mail) => `${mail.subject}\n${mail.text}`).join('\n');
    expect(everything).not.toContain(secret);
    for (const recoveryCode of recoveryCodes) expect(everything).not.toContain(recoveryCode);
    expect(everything).not.toMatch(/token=|[0-9]{6}/);
  });
});
