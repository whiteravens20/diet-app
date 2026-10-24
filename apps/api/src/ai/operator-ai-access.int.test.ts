// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdminOperatorAi, AiQuotaStatus } from '@diet-app/shared';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aUser, as, asAdmin, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { UsersService } from '../users/users.service.js';
import { AiRouterService, type RoutedResult } from './ai-router.service.js';
import { MEAL_SWAP } from './operations.js';

/** The instance's limit; the new accounts may use a tenth of it together. */
const INSTANCE_LIMIT = 30;
const NEW_ACCOUNTS_LIMIT = 3;
const DAY_MS = 86_400_000;

describe("who may use the operator's provider, as an instance is set up by default", () => {
  let t: TestApp;
  let router: AiRouterService;
  let user: TestUser;

  beforeAll(async () => {
    // Who may use it and the new accounts' part are left as an instance has them unless it says otherwise.
    t = await createTestApp({ AI_ADMIN_ACCESS: '', AI_ADMIN_NEW_ACCOUNT_DAYS: '', AI_ADMIN_INSTANCE_MONTHLY_LIMIT: String(INSTANCE_LIMIT) });
    await resetDatabase(t.prisma);
    router = t.app.get(AiRouterService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    t.model.reply({ text: '{"recipeId":"a"}', times: 100 });
    user = await aUser(t);
  });

  const ask = (who: TestUser = user): Promise<RoutedResult> => router.chat(who.id, [{ role: 'user', content: 'pick one' }], MEAL_SWAP, true);
  const quota = async (who: TestUser = user): Promise<AiQuotaStatus> =>
    (await t.http().get('/api/ai/quota').set(as(who)).expect(200)).body as AiQuotaStatus;
  const approve = (email: string) => t.http().put('/api/admin/accounts/operator-ai').set(asAdmin).send({ email });
  const revoke = (email: string) => t.http().delete('/api/admin/accounts/operator-ai').set(asAdmin).send({ email });
  const operatorAi = async (): Promise<AdminOperatorAi> =>
    (await t.http().get('/api/admin/accounts/operator-ai').set(asAdmin).expect(200)).body as AdminOperatorAi;
  /** Make the account as old as `days`. */
  const aged = (who: TestUser, days: number) =>
    t.prisma.user.update({ where: { id: who.id }, data: { createdAt: new Date(Date.now() - days * DAY_MS) } });
  const inAdminMode = (who: TestUser) => t.prisma.user.update({ where: { id: who.id }, data: { aiMode: 'admin' } });

  describe('an account the operator has not approved', () => {
    it('is not offered the operator\'s provider, and cannot switch to it', async () => {
      expect(await quota()).toMatchObject({ mode: 'none', adminAccess: 'not_approved' });

      const refused = await t.http().patch('/api/users/me').set(as(user)).send({ aiMode: 'admin' });

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: 'AI_NOT_PERMITTED' });
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).aiMode).toBe('none');
    });

    it('in the operator\'s mode already, is refused before the provider is asked, and is told why', async () => {
      await inAdminMode(user);

      const { text, meta } = await ask();

      expect(text).toBeNull();
      expect(meta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'not_permitted' });
      expect(t.model.requests).toHaveLength(0);
      expect(await t.prisma.aiUsageLog.count()).toBe(0);
      expect(await quota()).toMatchObject({ mode: 'admin', adminAccess: 'not_approved', remaining: 0, resetAt: null });
    });

    it('has AI turned off, not handed to the operator\'s provider, when its last own key goes', async () => {
      const own = await t.http().put('/api/ai/providers').set(as(user)).send({ provider: 'openai', apiKey: 'sk-test-key-0123456789', model: 'gpt-test' }).expect(200);
      await t.http().patch('/api/users/me').set(as(user)).send({ aiMode: 'byok' }).expect(200);

      await t.http().delete(`/api/ai/providers/${(own.body as { id: string }).id}`).set(as(user)).expect(204);

      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).aiMode).toBe('none');
    });
  });

  describe('the operator in the admin panel', () => {
    it('approves an account by its address, which then may use the provider', async () => {
      await aged(user, 30);

      await approve(user.email.toUpperCase()).expect(204);
      await t.http().patch('/api/users/me').set(as(user)).send({ aiMode: 'admin' }).expect(200);
      const { text } = await ask();

      expect(text).toBe('{"recipeId":"a"}');
      expect(await quota()).toMatchObject({ mode: 'admin', adminAccess: 'granted', remaining: 39 });
      expect(await operatorAi()).toEqual({ access: 'approved', mailConfigured: false, approved: 1 });
    });

    it('takes an approval back: the mode stays, and the next request is refused with the reason', async () => {
      await aged(user, 30);
      await approve(user.email).expect(204);
      await inAdminMode(user);

      await revoke(user.email).expect(204);

      expect((await ask()).meta.fallbackReason).toBe('not_permitted');
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).aiMode).toBe('admin');
      expect(await operatorAi()).toMatchObject({ approved: 0 });
    });

    it('is told when no account has the address', async () => {
      const answer = await approve('nobody@example.test');

      expect(answer.status).toBe(404);
      expect(answer.body).toMatchObject({ error: 'USER_NOT_FOUND' });
      expect((await revoke('nobody@example.test')).status).toBe(404);
    });

    it('is the only one who may approve', async () => {
      expect((await t.http().put('/api/admin/accounts/operator-ai').set(as(user)).send({ email: user.email })).status).toBe(401);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).operatorAiApprovedAt).toBeNull();
    });
  });

  describe('the new accounts', () => {
    /** An approved account in the operator's mode, as old as `days`. */
    async function anApproved(days: number): Promise<TestUser> {
      const account = await aUser(t);
      await aged(account, days);
      await t.prisma.user.update({ where: { id: account.id }, data: { aiMode: 'admin', operatorAiApprovedAt: new Date() } });
      return account;
    }

    it('share a tenth of the instance\'s limit, and an account that is not new keeps its own', async () => {
      const [first, second, third, older] = [await anApproved(1), await anApproved(2), await anApproved(0), await anApproved(8)];

      expect((await ask(first)).text).not.toBeNull();
      expect((await ask(first)).text).not.toBeNull();
      expect((await ask(second)).text).not.toBeNull();
      const refused = await ask(third);
      const answered = await ask(older);

      expect(refused.meta.fallbackReason).toBe('new_accounts_quota_exhausted');
      expect(answered.text).not.toBeNull();
      expect(t.model.requests).toHaveLength(NEW_ACCOUNTS_LIMIT + 1);
      const status = await quota(third);
      expect(status).toMatchObject({ adminAccess: 'granted', newAccountsLimitReached: true, remaining: 0 });
      // Its own place comes when it is no longer new.
      const createdAt = (await t.prisma.user.findUniqueOrThrow({ where: { id: third.id } })).createdAt;
      expect(status.newUntil).toBe(new Date(createdAt.getTime() + 7 * DAY_MS).toISOString());
      expect(status.resetAt).toBe(status.newUntil);
      expect(await quota(older)).toMatchObject({ newUntil: null, remaining: 39 });
    });

    it('stop counting for the part once they are no longer new', async () => {
      const [first, second] = [await anApproved(1), await anApproved(1)];
      for (let i = 0; i < NEW_ACCOUNTS_LIMIT; i += 1) await ask(first);
      expect((await ask(second)).meta.fallbackReason).toBe('new_accounts_quota_exhausted');

      await aged(first, 8);

      expect((await ask(second)).text).not.toBeNull();
    });

    it('do not give the part back by being deleted', async () => {
      const [first, second] = [await anApproved(1), await anApproved(1)];
      for (let i = 0; i < NEW_ACCOUNTS_LIMIT; i += 1) await ask(first);

      await t.app.get(UsersService).deleteAccount(first.id, { currentPassword: first.password });

      expect((await ask(second)).meta.fallbackReason).toBe('new_accounts_quota_exhausted');
      expect(await t.prisma.aiUsageOfDeletedAccounts.aggregate({ _sum: { calls: true, newAccountCalls: true } })).toEqual({
        _sum: { calls: NEW_ACCOUNTS_LIMIT, newAccountCalls: NEW_ACCOUNTS_LIMIT },
      });
    });

    it('are counted only for the days they are new when an account that was not new is deleted', async () => {
      const [older, fresh] = [await anApproved(8), await anApproved(1)];
      for (let i = 0; i < NEW_ACCOUNTS_LIMIT; i += 1) await ask(older);

      await t.app.get(UsersService).deleteAccount(older.id, { currentPassword: older.password });

      expect((await ask(fresh)).text).not.toBeNull();
      expect(await t.prisma.aiUsageOfDeletedAccounts.aggregate({ _sum: { newAccountCalls: true } })).toEqual({ _sum: { newAccountCalls: 0 } });
    });
  });
});
