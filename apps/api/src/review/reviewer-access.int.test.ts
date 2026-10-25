// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as bcrypt from 'bcrypt';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aReviewerSession, asAdmin } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const WEB = 'http://localhost:3000';
const PASSWORD = 'Reviewers-Passw0rd';

describe("the reviewers' way in", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await settings({ reviewerEnabled: true, reviewerPassword: PASSWORD }).expect(200);
  });

  const settings = (patch: Record<string, unknown>) =>
    t.http().patch('/api/admin/instance-settings').set(asAdmin).send(patch);
  /** Sign in as a reviewer through the door and return the cookie header of the session. The door takes five a minute. */
  const throughTheDoor = async (password = PASSWORD): Promise<string> => {
    const res = await t
      .http()
      .post('/api/review/auth')
      .set({ Origin: WEB })
      .send({ password, label: 'pl reviewer' })
      .expect(204);
    return /reviewer_session=[^;]+/.exec(String(res.headers['set-cookie']))![0];
  };
  /** The cookie of a session as a sign-in now would leave it. */
  const signIn = async (): Promise<string> => (await aReviewerSession(t)).Cookie;
  const drafts = (cookie: string) =>
    t.http().get('/api/review/drafts/recipes?locale=pl').set('Cookie', cookie);

  describe('the password reviewers share', () => {
    it.each([
      ['a single character', 'a'],
      ['eleven characters', 'elevenchars'],
    ])('is not taken when it is %s', async (_name, password) => {
      const refused = await settings({ reviewerPassword: password }).expect(400);

      expect(refused.body.error).toBe('VALIDATION_FAILED');
      expect(refused.body.issues).toMatchObject([{ path: 'reviewerPassword' }]);
      // The one before is still the password.
      expect((await settings({}).expect(200)).body).toMatchObject({ reviewerPasswordSet: true });
      await drafts(await signIn()).expect(200);
    });

    it('is taken away by an empty one, which closes the door', async () => {
      expect((await settings({ reviewerPassword: '' }).expect(200)).body).toMatchObject({
        reviewerPasswordSet: false,
      });

      expect(
        (
          await t
            .http()
            .post('/api/review/auth')
            .set({ Origin: WEB })
            .send({ password: PASSWORD, label: 'x' })
            .expect(401)
        ).body.error,
      ).toBe('REVIEWER_DISABLED');
    });

    it("is kept like the passwords of accounts: with the application's key in it, and told apart to its last character", async () => {
      const long = `${'x'.repeat(100)}1`;
      await settings({ reviewerPassword: long }).expect(200);
      const { reviewerPasswordHash } = await t.prisma.instanceSettings.findFirstOrThrow();

      // Not what bcrypt alone makes of the password, which reads no more than 72 bytes of it.
      expect(await bcrypt.compare(long, reviewerPasswordHash!)).toBe(false);
      await throughTheDoor(long);
      await t
        .http()
        .post('/api/review/auth')
        .set({ Origin: WEB })
        .send({ password: `${'x'.repeat(100)}2`, label: 'x' })
        .expect(401);
    });

    it('is not accepted with unknown fields beside it', async () => {
      await settings({ reviewerPassword: PASSWORD, reviewerPasswordHash: 'x' }).expect(400);
    });
  });

  describe('a session of a reviewer', () => {
    it('is a cookie no script reads, sent with nothing another site causes', async () => {
      const res = await t
        .http()
        .post('/api/review/auth')
        .set({ Origin: WEB })
        .send({ password: PASSWORD, label: 'pl reviewer' })
        .expect(204);
      const attributes = String(res.headers['set-cookie']).split('; ');

      expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/']));
      await drafts(/reviewer_session=[^;]+/.exec(String(res.headers['set-cookie']))![0]).expect(
        200,
      );
    });

    it('ends when the password is changed', async () => {
      const cookie = await signIn();

      await settings({ reviewerPassword: 'Another-Reviewers-Passw0rd' }).expect(200);

      expect((await drafts(cookie).expect(401)).body.error).toBe('INVALID_REVIEWER_SESSION');
    });

    it('ends when the panel is closed, and does not come back when it is opened again', async () => {
      const cookie = await signIn();

      await settings({ reviewerEnabled: false }).expect(200);
      expect((await drafts(cookie).expect(403)).body.error).toBe('REVIEWER_DISABLED');
      await settings({ reviewerEnabled: true }).expect(200);

      expect((await drafts(cookie).expect(401)).body.error).toBe('INVALID_REVIEWER_SESSION');
      // Whoever knows the password signs in anew.
      await drafts(await signIn()).expect(200);
    });

    it('goes on through a change of settings that is no change', async () => {
      const cookie = await signIn();

      await settings({ reviewerEnabled: true }).expect(200);

      await drafts(cookie).expect(200);
    });

    it('is told what it is: the session of before, or none', async () => {
      const cookie = await signIn();

      expect(
        (await t.http().get('/api/review/session').set('Cookie', cookie).expect(200)).body.session,
      ).toMatchObject({ label: 'pl reviewer' });
      await settings({ reviewerPassword: 'Another-Reviewers-Passw0rd' }).expect(200);
      expect(
        (await t.http().get('/api/review/session').set('Cookie', cookie).expect(200)).body.session,
      ).toBeNull();
    });
  });

  describe("a request that changes something with a reviewer's session", () => {
    it.each([
      ['from another site', { Origin: 'https://elsewhere.example' }],
      ['that does not say where it comes from', {}],
    ])('is refused %s', async (_name, headers) => {
      const cookie = await signIn();

      const refused = await t
        .http()
        .post('/api/review/drafts/recipes/00000000-0000-4000-8000-000000000000/approve')
        .set('Cookie', cookie)
        .set(headers)
        .send({ locale: 'pl' });

      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('is looked at when it comes from the application', async () => {
      const cookie = await signIn();

      const answered = await t
        .http()
        .post('/api/review/drafts/recipes/00000000-0000-4000-8000-000000000000/approve')
        .set('Cookie', cookie)
        .set({ Origin: WEB })
        .send({ locale: 'pl' });

      // It got past the door: what it is answered is about the request itself.
      expect(answered.status).not.toBe(403);
      expect(answered.body.error).not.toBe('ORIGIN_NOT_ALLOWED');
    });

    it('is not needed for reading', async () => {
      await drafts(await signIn()).expect(200);
    });

    it('covers the sign-in itself: a page of another site cannot sign a visitor in', async () => {
      const refused = await t
        .http()
        .post('/api/review/auth')
        .set({ Origin: 'https://elsewhere.example' })
        .send({ password: PASSWORD, label: 'x' });

      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('ORIGIN_NOT_ALLOWED');
    });
  });
});
