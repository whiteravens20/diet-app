// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveReviewerSecret, signReviewerCookie, verifyReviewerCookie } from '../review/session.js';
import { resetDatabase } from '../testing/database.js';
import { aSession, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { SessionsService } from './sessions.service.js';
import { ConfigService } from '@nestjs/config';

// The key of the test application's access tokens.
const ACCESS_SECRET = 'integration-test-access-secret-0123456789';

const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const claimsOf = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));

describe('an access token', () => {
  let t: TestApp;
  let jwt: JwtService;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    jwt = t.app.get(JwtService, { strict: false });
    user = await aUser(t);
  });

  afterAll(async () => {
    await t.close();
  });

  const me = (token: string) => t.http().get('/api/users/me').set({ Authorization: `Bearer ${token}` });

  it('says whose it is, of which session, what it is for and until when, and nothing else about the account', async () => {
    const claims = claimsOf(user.accessToken);

    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'sid', 'sub']);
    expect(claims.sub).toBe(user.id);
    expect(claims.sid).toBe((await t.prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } })).familyId);
    expect(user.accessToken).not.toContain(Buffer.from(user.email).toString('base64url').slice(0, 12));
    expect(JSON.parse(Buffer.from(user.accessToken.split('.')[0]!, 'base64url').toString('utf8'))).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('opens what a signed-in account may see', async () => {
    expect((await me(user.accessToken).expect(200)).body.id).toBe(user.id);
  });

  it.each([
    ['is signed with another key', () => jwt.sign({ sub: user.id }, { secret: 'another-secret-0123456789abcdef', algorithm: 'HS256', audience: claimsOf(user.accessToken).aud as string })],
    ['says nothing of what it is for', () => jwt.sign({ sub: user.id }, { secret: ACCESS_SECRET, algorithm: 'HS256' })],
    ['was made for something else', () => jwt.sign({ sub: user.id }, { secret: ACCESS_SECRET, algorithm: 'HS256', audience: 'something-else' })],
    ['is signed in another way with the same key', () => jwt.sign({ sub: user.id }, { secret: ACCESS_SECRET, algorithm: 'HS512', audience: claimsOf(user.accessToken).aud as string })],
    ['is not signed at all', () => `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: user.id, aud: claimsOf(user.accessToken).aud, exp: Math.floor(Date.now() / 1000) + 600 })}.`],
    ['has run out', () => jwt.sign({ sub: user.id }, { secret: ACCESS_SECRET, algorithm: 'HS256', audience: claimsOf(user.accessToken).aud as string, expiresIn: -10 })],
    ['names nobody', () => jwt.sign({ sid: claimsOf(user.accessToken).sid }, { secret: ACCESS_SECRET, algorithm: 'HS256', audience: claimsOf(user.accessToken).aud as string })],
    ['names no session', () => jwt.sign({ sub: user.id }, { secret: ACCESS_SECRET, algorithm: 'HS256', audience: claimsOf(user.accessToken).aud as string })],
    ['names a session of another account', () => jwt.sign({ sub: user.id, sid: '00000000-0000-4000-8000-000000000000' }, { secret: ACCESS_SECRET, algorithm: 'HS256', audience: claimsOf(user.accessToken).aud as string })],
  ])('is refused when it %s', async (_name, make) => {
    await me(make()).expect(401);
  });

  it('is not what the reviewer panel hands out, even where the two were signed with one key', async () => {
    const { token } = signReviewerCookie(jwt, ACCESS_SECRET, { label: 'translator' });

    await me(token).expect(401);
  });

  describe('of a session that has ended, though the token itself has not run out', () => {
    let visitor: TestUser;
    let sessions: SessionsService;

    beforeEach(async () => {
      sessions = t.app.get(SessionsService);
      visitor = await aUser(t);
      await me(visitor.accessToken).expect(200);
    });

    it('is refused at once after signing out', async () => {
      await sessions.end(visitor.refreshToken);

      expect((await me(visitor.accessToken).expect(401)).body.error).toBe('INVALID_ACCESS_TOKEN');
    });

    it('is refused at once after signing out everywhere, and so is that of every other session', async () => {
      const other = await aSession(t, visitor);

      await t.http().delete('/api/users/me/sessions').set({ Authorization: `Bearer ${visitor.accessToken}` }).expect(204);

      await me(visitor.accessToken).expect(401);
      await me(other.tokens.accessToken).expect(401);
    });

    it('is refused once a refresh token of its session was used twice', async () => {
      const next = await sessions.refresh(visitor.refreshToken);
      await t.prisma.refreshToken.updateMany({ where: { userId: visitor.id, rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 11_000) } });
      await sessions.refresh(visitor.refreshToken).catch(() => undefined);

      await me(visitor.accessToken).expect(401);
      await me(next.tokens.accessToken).expect(401);
    });

    it('is refused once the password of the account was changed', async () => {
      await t.http().post('/api/users/me/password').set({ Authorization: `Bearer ${visitor.accessToken}` }).send({ currentPassword: visitor.password, newPassword: 'Another-Passw0rd-1' }).expect(204);

      await me(visitor.accessToken).expect(401);
    });

    it('goes on working while its session does, through every refresh', async () => {
      const next = await sessions.refresh(visitor.refreshToken);

      await me(visitor.accessToken).expect(200);
      await me(next.tokens.accessToken).expect(200);
    });

    it('is no concern of another session of the same account', async () => {
      const other = await aSession(t, visitor);

      await sessions.end(visitor.refreshToken);

      await me(other.tokens.accessToken).expect(200);
    });
  });

  it('is refused once its account is gone, though it has not run out', async () => {
    const gone = await aUser(t);
    await me(gone.accessToken).expect(200);
    await t.prisma.user.delete({ where: { id: gone.id } });

    expect((await me(gone.accessToken).expect(401)).body.error).toBe('INVALID_ACCESS_TOKEN');
    // A write would otherwise be made for an account that does not exist.
    await t.http().post('/api/profiles').set({ Authorization: `Bearer ${gone.accessToken}` }).send({ name: 'Ghost', age: 30, sex: 'male', heightCm: 180, weightKg: 80, activityLevel: 'moderate', weeklyLossTarget: null }).expect(401);
  });
});

describe('the token of a reviewer session', () => {
  let t: TestApp;
  let jwt: JwtService;
  let secret: string;

  beforeAll(async () => {
    t = await createTestApp();
    jwt = t.app.get(JwtService, { strict: false });
    secret = resolveReviewerSecret(t.app.get(ConfigService));
  });

  afterAll(async () => {
    await t.close();
  });

  it('is read back as the session it was made for', () => {
    const { token } = signReviewerCookie(jwt, secret, { label: 'translator' });

    expect(verifyReviewerCookie(jwt, secret, token)).toMatchObject({ label: 'translator' });
    expect(Object.keys(claimsOf(token)).sort()).toEqual(['aud', 'exp', 'iat', 'label']);
  });

  it.each([
    ['an access token of an account, signed with the same key', () => jwt.sign({ sub: 'user-1', label: 'translator' }, { secret, algorithm: 'HS256', audience: 'diet-app/account' })],
    ['a token that says nothing of what it is for', () => jwt.sign({ label: 'translator' }, { secret, algorithm: 'HS256' })],
    ['a token signed in another way with the same key', () => jwt.sign({ label: 'translator' }, { secret, algorithm: 'HS512', audience: claimsOf(signReviewerCookie(jwt, secret, { label: 'x' }).token).aud as string })],
    ['a token signed with another key', () => signReviewerCookie(jwt, 'another-secret-0123456789abcdef', { label: 'translator' }).token],
    ['text that is no token', () => 'not-a-token'],
  ])('is not %s', (_name, make) => {
    expect(verifyReviewerCookie(jwt, secret, make())).toBeNull();
  });
});
