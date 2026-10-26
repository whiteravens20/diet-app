// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, asAdmin } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AdminSecondFactorReset } from './admin-second-factor-reset.js';

describe('an instance started with ADMIN_SECOND_FACTOR_RESET on', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ ADMIN_SECOND_FACTOR_RESET: 'true' });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });

  /** What the application does when it starts, once more. */
  const start = () => t.app.get(AdminSecondFactorReset).onApplicationBootstrap();

  it("removes the administrator's second factor when it starts: the panel opens with the password alone", async () => {
    await t.prisma.secondFactor.create({
      data: {
        id: 'administrator',
        secretEncrypted: 'of-a-lost-app',
        lastStep: 0,
        failures: 9,
        blockedUntil: new Date(Date.now() + 3_600_000),
      },
    });

    await start();

    expect(await t.prisma.secondFactor.count()).toBe(0);
    expect((await t.http().get('/api/admin/session').expect(200)).body).toMatchObject({
      enabled: true,
      secondFactor: false,
    });
    await t
      .http()
      .post('/api/admin/session')
      .set('Origin', 'http://localhost:3000')
      .send({ user: 'admin', password: 'integration-test-admin-password' })
      .expect(204);
  });

  it('leaves the second factor of an account where it is', async () => {
    const user = await aUser(t);
    await t.prisma.secondFactor.create({
      data: { userId: user.id, secretEncrypted: 'of-an-account', lastStep: 0 },
    });

    await start();

    expect(await t.prisma.secondFactor.count({ where: { userId: user.id } })).toBe(1);
  });

  it('lets none be set up: it would be gone at the next start, with nobody the wiser', async () => {
    const refused = await t
      .http()
      .post('/api/admin/session/second-factor/setup')
      .set(asAdmin)
      .send({ password: 'integration-test-admin-password' })
      .expect(409);

    expect(refused.body.error).toBe('ADMIN_SECOND_FACTOR_RESET_SET');
    expect(
      (
        await t
          .http()
          .post('/api/admin/session/second-factor')
          .set(asAdmin)
          .send({ enrolment: 'v2:00:00:00', code: '123456' })
          .expect(409)
      ).body.error,
    ).toBe('ADMIN_SECOND_FACTOR_RESET_SET');
  });
});
