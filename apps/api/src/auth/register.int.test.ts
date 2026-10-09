// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { race } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AuthService } from './auth.service.js';

describe('registering an account', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('refuses the second of two overlapping registrations of one address as taken', async () => {
    const auth = t.app.get(AuthService);
    const dto = { email: 'twice@example.test', password: 'Overlap-Passw0rd', displayName: 'Twice' };

    const results = await race(2, () => auth.register(dto));

    const refused = results.filter((r) => r.status === 'rejected').map((r) => r.reason as HttpException);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(HttpException);
    expect(refused[0]!.getStatus()).toBe(409);
    expect(refused[0]!.getResponse()).toMatchObject({ error: 'EMAIL_TAKEN' });
    expect(await t.prisma.user.count()).toBe(1);
  });

  it('treats the same address in another letter case as the same account', async () => {
    const auth = t.app.get(AuthService);
    await auth.register({ email: 'Mixed.Case@Example.Test', password: 'Letter-Case-Passw0rd', displayName: 'Mixed' });

    await expect(
      auth.register({ email: 'mixed.case@example.test', password: 'Letter-Case-Passw0rd', displayName: 'Lower' }),
    ).rejects.toMatchObject({ response: { error: 'EMAIL_TAKEN' } });
    await expect(
      auth.login({ email: 'MIXED.CASE@EXAMPLE.TEST', password: 'Letter-Case-Passw0rd' }),
    ).resolves.toMatchObject({ user: { displayName: 'Mixed' } });
  });
});
