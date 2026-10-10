// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiQuotaStatus } from '@diet-app/shared';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aUser, as, race, type TestUser } from '../testing/factories.js';
import { startFakeModel, type FakeModel } from '../testing/fake-model.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AiRouterService, type RoutedResult } from './ai-router.service.js';
import { MEAL_SWAP } from './operations.js';

const LIMIT = 3;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe("a user's monthly allowance on the operator's provider", () => {
  let t: TestApp;
  /** A model the user runs themself, apart from the operator's. */
  let own: FakeModel;
  let router: AiRouterService;
  let user: TestUser;

  beforeAll(async () => {
    own = await startFakeModel();
    t = await createTestApp({
      AI_ADMIN_USER_MONTHLY_LIMIT: String(LIMIT),
      OLLAMA_ALLOWED_HOSTS: new URL(own.url).host,
    });
    await resetDatabase(t.prisma);
    router = t.app.get(AiRouterService);
  });

  afterAll(async () => {
    await t.close();
    await own.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    own.reset();
    user = await aUser(t);
    await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
  });

  const ask = (): Promise<RoutedResult> =>
    router.chat(user.id, [{ role: 'user', content: 'pick one' }], MEAL_SWAP, true);

  const quota = async (): Promise<AiQuotaStatus> =>
    (await t.http().get('/api/ai/quota').set(as(user)).expect(200)).body as AiQuotaStatus;

  const outcomes = async (): Promise<string[]> =>
    (await t.prisma.aiUsageLog.findMany({ orderBy: { createdAt: 'asc' } })).map((row) => row.outcome);

  it('starts full', async () => {
    expect(await quota()).toMatchObject({ mode: 'admin', limit: LIMIT, used: 0, remaining: LIMIT, resetAt: null });
  });

  it('is used by an answer, and says when the place comes free again', async () => {
    t.model.reply({ text: '{"recipeId":"a"}' });

    const result = await ask();

    expect(result.text).toBe('{"recipeId":"a"}');
    const status = await quota();
    expect(status).toMatchObject({ used: 1, remaining: LIMIT - 1 });
    const freeIn = new Date(status.resetAt!).getTime() - Date.now();
    expect(freeIn / 86_400_000).toBeCloseTo(30, 1);
    expect(await outcomes()).toEqual(['COMPLETED']);
  });

  it('is used by an answer the application cannot read, because the provider was paid for it', async () => {
    t.model.reply({ text: 'I would rather not answer in JSON.' });

    await ask();

    expect((await quota()).used).toBe(1);
  });

  it('is not used by a provider that fails', async () => {
    t.model.reply({ status: 500, text: 'out of memory' });

    const result = await ask();

    expect(result.meta.fallbackReason).toBe('all_providers_failed');
    expect(await quota()).toMatchObject({ used: 0, remaining: LIMIT, resetAt: null });
    // The failure is still on record.
    expect(await outcomes()).toEqual(['FAILED']);
  });

  it('refuses further calls once it is used up, without asking the provider', async () => {
    t.model.reply({ text: '{}', times: 10 });
    for (let call = 0; call < LIMIT; call += 1) await ask();

    const refused = await ask();

    expect(refused.text).toBeNull();
    expect(refused.meta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'quota_exhausted' });
    expect(t.model.requests).toHaveLength(LIMIT);
    expect(await quota()).toMatchObject({ used: LIMIT, remaining: 0 });
  });

  it('cannot be exceeded by calls made at the same moment', async () => {
    // Slow enough that every call has started before the first one is answered.
    t.model.reply({ text: '{}', delayMs: 300, times: 20 });

    const results = await race(8, ask);

    const answered = results.filter((r) => r.status === 'fulfilled' && r.value.text !== null);
    const refused = results.filter(
      (r) => r.status === 'fulfilled' && r.value.meta.fallbackReason === 'quota_exhausted',
    );
    expect(answered).toHaveLength(LIMIT);
    expect(refused).toHaveLength(8 - LIMIT);
    expect(t.model.requests).toHaveLength(LIMIT);
    expect((await quota()).used).toBe(LIMIT);
  });

  it('holds a place for a call in flight and gives it back when the call fails', async () => {
    t.model.reply({ status: 500, text: 'out of memory', delayMs: 400 });

    const inFlight = ask();
    await sleep(150);
    expect((await quota()).used).toBe(1);

    await inFlight;
    expect((await quota()).used).toBe(0);
  });

  it('forgets a call thirty days after it was made', async () => {
    const call = { userId: user.id, provider: 'ollama', model: 'test-model', operation: 'meal-swap', mode: 'admin' };
    const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);
    await t.prisma.aiUsageLog.createMany({
      data: [
        { ...call, outcome: 'COMPLETED', createdAt: daysAgo(31) },
        { ...call, outcome: 'COMPLETED', createdAt: daysAgo(29) },
      ],
    });

    expect((await quota()).used).toBe(1);
  });

  it('does not let a call that a restart left unfinished hold its place for good', async () => {
    const call = { userId: user.id, provider: 'ollama', model: 'test-model', operation: 'meal-swap', mode: 'admin' };
    await t.prisma.aiUsageLog.createMany({
      data: [
        { ...call, outcome: 'PENDING', createdAt: new Date(Date.now() - 10 * 60_000) },
        { ...call, outcome: 'PENDING' },
      ],
    });

    expect((await quota()).used).toBe(1);
  });

  it("does not count another user's calls", async () => {
    t.model.reply({ text: '{}', times: 10 });
    const other = await aUser(t);
    await t.prisma.user.update({ where: { id: other.id }, data: { aiMode: 'admin' } });
    for (let call = 0; call < LIMIT; call += 1) {
      await router.chat(other.id, [{ role: 'user', content: 'pick one' }], MEAL_SWAP, true);
    }

    expect((await quota()).used).toBe(0);
    expect((await ask()).text).toBe('{}');
  });

  describe("on the user's own provider", () => {
    beforeEach(async () => {
      await t
        .http()
        .put('/api/ai/providers')
        .set(as(user))
        .send({ provider: 'ollama', baseUrl: own.url, model: 'own-model' })
        .expect(200);
      await t.http().patch('/api/users/me').set(as(user)).send({ aiMode: 'byok' }).expect(200);
    });

    it("an entry that points at the operator's instance is counted like any other call on it", async () => {
      await t
        .http()
        .put('/api/ai/providers')
        .set(as(user))
        .send({ provider: 'ollama', baseUrl: t.model.url, model: 'borrowed-model' })
        .expect(200);
      t.model.reply({ text: '{"recipeId":"borrowed"}', times: 10 });

      for (let call = 0; call < LIMIT; call += 1) {
        expect((await ask()).text).toBe('{"recipeId":"borrowed"}');
      }
      const refused = await ask();

      expect(refused.meta.fallbackReason).toBe('quota_exhausted');
      expect(t.model.requests).toHaveLength(LIMIT);
      expect((await quota()).used).toBe(LIMIT);
      const rows = await t.prisma.aiUsageLog.findMany();
      expect(rows.map((row) => row.mode)).toEqual(Array(LIMIT).fill('admin'));
    });

    it('nothing is counted and nothing is refused', async () => {
      own.reply({ text: '{"recipeId":"mine"}', times: 10 });

      for (let call = 0; call < LIMIT + 2; call += 1) {
        expect((await ask()).text).toBe('{"recipeId":"mine"}');
      }

      expect(own.requests).toHaveLength(LIMIT + 2);
      expect(t.model.requests).toHaveLength(0);
      expect(await quota()).toMatchObject({ mode: 'byok', used: 0, remaining: null });
      const rows = await t.prisma.aiUsageLog.findMany();
      expect(rows.map((row) => [row.mode, row.outcome])).toEqual(Array(LIMIT + 2).fill(['byok', 'COMPLETED']));
    });
  });
});
