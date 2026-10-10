// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiQuotaStatus } from '@diet-app/shared';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AiRouterService, type RoutedResult } from './ai-router.service.js';
import { MEAL_SWAP } from './operations.js';

const PER_USER = 5;
const INSTANCE = 2;

describe("the instance's monthly allowance on the operator's provider", () => {
  let t: TestApp;
  let router: AiRouterService;
  let first: TestUser;
  let second: TestUser;

  beforeAll(async () => {
    t = await createTestApp({
      AI_ADMIN_USER_MONTHLY_LIMIT: String(PER_USER),
      AI_ADMIN_INSTANCE_MONTHLY_LIMIT: String(INSTANCE),
    });
    await resetDatabase(t.prisma);
    router = t.app.get(AiRouterService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    first = await aUser(t);
    second = await aUser(t);
    await t.prisma.user.updateMany({ data: { aiMode: 'admin' } });
  });

  const ask = (user: TestUser): Promise<RoutedResult> =>
    router.chat(user.id, [{ role: 'user', content: 'pick one' }], MEAL_SWAP, true);

  const quota = async (user: TestUser): Promise<AiQuotaStatus> =>
    (await t.http().get('/api/ai/quota').set(as(user)).expect(200)).body as AiQuotaStatus;

  it('closes the provider to every user once all users together have used it up', async () => {
    t.model.reply({ text: '{}', times: 10 });
    await ask(first);
    await ask(first);

    const refused = await ask(second);

    expect(refused.text).toBeNull();
    expect(refused.meta).toMatchObject({
      usedDeterministicFallback: true,
      fallbackReason: 'instance_quota_exhausted',
    });
    expect(t.model.requests).toHaveLength(INSTANCE);
  });

  it('tells a user who has their own allowance left that the instance has none', async () => {
    t.model.reply({ text: '{}', times: 10 });
    expect(await quota(second)).toMatchObject({ used: 0, remaining: PER_USER, instanceLimitReached: false });

    await ask(first);
    await ask(first);

    const status = await quota(second);
    expect(status).toMatchObject({ used: 0, limit: PER_USER, remaining: 0, instanceLimitReached: true });
    // The place that comes free is the instance's oldest call, not one of this user's.
    const freeIn = new Date(status.resetAt!).getTime() - Date.now();
    expect(freeIn / 86_400_000).toBeCloseTo(30, 1);
  });

  it('cannot be exceeded by different users calling at the same moment', async () => {
    t.model.reply({ text: '{}', delayMs: 300, times: 20 });

    const results = await race(8, (index) => ask(index % 2 === 0 ? first : second));

    const answered = results.filter((r) => r.status === 'fulfilled' && r.value.text !== null);
    expect(answered).toHaveLength(INSTANCE);
    expect(t.model.requests).toHaveLength(INSTANCE);
  });

  it('still counts the calls of an account that has since been deleted', async () => {
    t.model.reply({ text: '{}', times: 10 });
    await ask(first);
    await ask(first);
    await t.prisma.user.delete({ where: { id: first.id } });

    expect((await ask(second)).meta.fallbackReason).toBe('instance_quota_exhausted');
  });

  it('is not used by a provider that fails', async () => {
    t.model.reply({ status: 500, text: 'out of memory', times: 4 });
    for (let call = 0; call < 4; call += 1) await ask(first);
    t.model.reply({ text: '{"recipeId":"a"}' });

    expect((await ask(second)).text).toBe('{"recipeId":"a"}');
  });
});
