// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/** One reverse proxy stands in front and is trusted: it writes the client's address into the header. */
describe('rate limits behind one trusted proxy', () => {
  let t: TestApp;
  let sequence = 0;

  beforeAll(async () => {
    t = await createTestApp({ TRUST_PROXY: '1' });
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  const register = (forwardedFor: string) =>
    t
      .http()
      .post('/api/auth/register')
      .set('X-Forwarded-For', forwardedFor)
      .send({ email: `visitor-${(sequence += 1)}-${Date.now().toString(36)}@example.test`, password: 'Integration-Passw0rd', displayName: 'Visitor' });
  const basic = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };

  it('gives two clients an allowance each', async () => {
    const first: number[] = [];
    for (let i = 0; i < 11; i += 1) first.push((await register('203.0.113.7')).status);

    expect(first).toEqual([...Array(10).fill(201), 429]);
    expect((await register('203.0.113.8')).status).toBe(201);
  });

  it('believes the address the proxy wrote, not one a client wrote in front of it', async () => {
    // The proxy appends what it saw; whatever stood there before is the client's own claim.
    const res = await register('198.51.100.99, 203.0.113.7');

    // Counted as 203.0.113.7, whose allowance the first test used up.
    expect(res.status).toBe(429);
  });

  it('counts a wrong administrator password against the client, not against the proxy', async () => {
    const wrong = { Authorization: `Basic ${Buffer.from('admin:not-the-password').toString('base64')}` };
    for (let i = 0; i < 5; i += 1) {
      await t.http().get('/api/admin/stats').set(wrong).set('X-Forwarded-For', '203.0.113.50').expect(401);
    }

    // The guesser waits; the administrator, at another address, does not.
    await t.http().get('/api/admin/stats').set(basic).set('X-Forwarded-For', '203.0.113.50').expect(429);
    await t.http().get('/api/admin/stats').set(basic).set('X-Forwarded-For', '203.0.113.60').expect(200);
  });
});
