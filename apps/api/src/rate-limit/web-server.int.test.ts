// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { WebServer } from './web-server.js';

/**
 * With no reverse proxy the operator vouches for (`TRUST_PROXY` empty), the bundled web server says whose
 * connection it accepted, and the limits count that client. The tests' requests come from the loopback, which the
 * web server's name is made to resolve to where a test says so.
 */
describe('rate limits by the address the web server accepted the connection from', () => {
  let t: TestApp;
  let web: WebServer;
  let sequence = 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    web = t.app.get(WebServer);
  });

  afterEach(async () => {
    web.resolve = async () => [];
    await web.refresh();
  });

  afterAll(async () => {
    await t.close();
  });

  /** The web server is the loopback, where the tests' requests come from. */
  const theWebServerIsHere = async () => {
    web.resolve = async () => ['127.0.0.1', '::1'];
    await web.refresh();
  };
  const login = (from: string, email: string, password: string) =>
    t.http().post('/api/auth/login').set('X-Client-Address', from).send({ email, password });
  const register = (from: string) =>
    t
      .http()
      .post('/api/auth/register')
      .set('X-Client-Address', from)
      .send({
        email: `visitor-${(sequence += 1)}-${Date.now().toString(36)}@example.test`,
        password: 'Integration-Passw0rd',
        displayName: 'Visitor',
      });

  it("keeps one client's wrong passwords from holding up the owner at another address", async () => {
    await theWebServerIsHere();
    const owner = await aUser(t);
    for (let i = 0; i < 10; i += 1)
      expect((await login('203.0.113.201', owner.email, 'not-the-password')).status).toBe(401);

    expect((await login('203.0.113.201', owner.email, owner.password)).status).toBe(429);
    expect((await login('203.0.113.202', owner.email, owner.password)).status).toBe(200);
  });

  it('counts the accounts each client opens, and only those', async () => {
    await theWebServerIsHere();
    for (let i = 0; i < 3; i += 1) expect((await register('203.0.113.211')).status).toBe(201);

    const fourth = await register('203.0.113.211');
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe('TOO_MANY_SIGN_UPS');
    expect((await register('203.0.113.212')).status).toBe(201);
  });

  it('takes no word for a shared address: behind a proxy, or on the loopback, every visitor has the gateway’s', async () => {
    await theWebServerIsHere();
    // The address a loopback port of the Compose network, or a proxy on the host, gives every connection: sign-ups
    // are not counted by it, as without the web server's word, or the fourth visitor of the day would be refused.
    for (let i = 0; i < 4; i += 1) expect((await register('172.19.0.1')).status).toBe(201);
  });

  it('counts a request whose header holds no address as its connection', async () => {
    await theWebServerIsHere();
    const owner = await aUser(t);
    for (let i = 0; i < 10; i += 1)
      expect((await login('not-an-address', owner.email, 'not-the-password')).status).toBe(401);

    expect((await login('203.0.113.0/24', owner.email, owner.password)).status).toBe(429);
  });

  it('believes the header from nobody but the web server: anyone else is counted as their connection', async () => {
    // The web server's name resolves elsewhere: the header the tests write is anybody's.
    web.resolve = async () => ['198.51.100.9'];
    await web.refresh();
    const owner = await aUser(t);
    for (let i = 0; i < 10; i += 1)
      expect((await login('203.0.113.221', owner.email, 'not-the-password')).status).toBe(401);

    // Another address written in the header changes nothing: it is the same connection.
    expect((await login('203.0.113.222', owner.email, owner.password)).status).toBe(429);
  });
});
