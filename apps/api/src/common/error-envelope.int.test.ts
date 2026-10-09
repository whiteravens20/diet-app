// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('failures become answers a client can act on', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('answers 413 to a body over the parser limit', async () => {
    const res = await t
      .http()
      .post('/api/auth/login')
      .send({ email: 'someone@example.test', password: 'x'.repeat(200_000) })
      .expect(413);
    expect(res.body).toMatchObject({ statusCode: 413, error: 'PAYLOAD_TOO_LARGE' });
  });

  it('answers 400 to a body that is not JSON', async () => {
    const res = await t
      .http()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'BAD_REQUEST' });
  });

  it('gives a stable code to a route that does not exist', async () => {
    const res = await t.http().get('/api/no-such-route').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: 'NOT_FOUND' });
  });

  it('gives a stable code to a request without a session', async () => {
    const res = await t.http().get('/api/profiles').expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, error: 'UNAUTHORIZED' });
  });

  // Last: it uses up the request allowance of the sign-in route for this file.
  it('answers 429 with a stable code and a Retry-After header when a route is over its limit', async () => {
    const attempt = () => t.http().post('/api/auth/login').send({ email: 'nobody@example.test', password: 'wrong' });
    let last = await attempt();
    for (let i = 0; i < 12 && last.status !== 429; i += 1) last = await attempt();

    expect(last.status).toBe(429);
    expect(last.body).toMatchObject({ statusCode: 429, error: 'RATE_LIMITED' });
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });
});
