// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { AiProviderConfig } from '@diet-app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AiKeyService } from './ai-key.service.js';
import { AiTestService } from './ai-test.service.js';

describe('the provider configurations of an account', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    user = await aUser(t);
  });

  const save = (as_: TestUser, model: string) =>
    t
      .http()
      .put('/api/ai/providers')
      .set(as(as_))
      .send({ provider: 'ollama', baseUrl: t.model.url, model });
  const listed = async (as_: TestUser): Promise<AiProviderConfig[]> =>
    (await t.http().get('/api/ai/providers').set(as(as_)).expect(200)).body;

  it('are one for each provider, however many saves arrive together', async () => {
    const answers = await race(6, (n) => save(user, `model-${n}`));

    expect(
      answers.map((answer) => (answer.status === 'fulfilled' ? answer.value.status : 0)),
    ).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await t.prisma.aiProviderConfig.count({ where: { userId: user.id } })).toBe(1);
  });

  it('are changed by a later save for the same provider, and keep their id', async () => {
    const first: AiProviderConfig = (await save(user, 'the-first-word').expect(200)).body;

    const second: AiProviderConfig = (await save(user, 'the-last-word').expect(200)).body;

    expect(second.id).toBe(first.id);
    expect(await listed(user)).toMatchObject([
      { id: first.id, provider: 'ollama', model: 'the-last-word' },
    ]);
  });

  describe("of OpenRouter, which name the endpoints that may serve the account's requests", () => {
    const openRouter = (as_: TestUser, more: Record<string, unknown> = {}) =>
      t
        .http()
        .put('/api/ai/providers')
        .set(as(as_))
        .send({ provider: 'openrouter', apiKey: 'sk-or-test', model: 'some/model', ...more });

    it('name those that do not train on the data until the account chooses otherwise', async () => {
      const made: AiProviderConfig = (await openRouter(user).expect(200)).body;
      expect(made.dataPolicy).toBe('no_training');

      const chosen: AiProviderConfig = (
        await openRouter(user, { dataPolicy: 'no_retention' }).expect(200)
      ).body;
      expect(chosen.dataPolicy).toBe('no_retention');
      expect(await listed(user)).toMatchObject([{ id: made.id, dataPolicy: 'no_retention' }]);
    });

    it('keep the choice when a client that does not know it saves the configuration again', async () => {
      await openRouter(user, { dataPolicy: 'any' }).expect(200);

      await openRouter(user, { model: 'another/model' }).expect(200);

      expect(await listed(user)).toMatchObject([{ model: 'another/model', dataPolicy: 'any' }]);
    });

    it('refuse a choice that is not one of the three', async () => {
      await openRouter(user, { dataPolicy: 'everything' }).expect(400);
      expect(await t.prisma.aiProviderConfig.count({ where: { userId: user.id } })).toBe(0);
    });

    it('are not a matter of another provider, which says it has no such choice', async () => {
      await save(user, 'local-model').expect(200);

      expect(await listed(user)).toMatchObject([{ provider: 'ollama', dataPolicy: null }]);
    });
  });

  describe('of a provider in the cloud, changed', () => {
    const put = (as_: TestUser, body: Record<string, unknown>) =>
      t.http().put('/api/ai/providers').set(as(as_)).send(body);
    const storedKey = async (as_: TestUser) =>
      (
        await t.prisma.aiProviderConfig.findFirstOrThrow({
          where: { userId: as_.id, provider: 'openrouter' },
        })
      ).encryptedKey;
    const keyRequired = {
      error: 'VALIDATION_FAILED',
      issues: [expect.objectContaining({ path: 'apiKey', message: 'AI_API_KEY_REQUIRED' })],
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('keep the saved key when the change leaves it out, and take the rest of the change', async () => {
      await put(user, {
        provider: 'openrouter',
        apiKey: 'sk-or-first',
        model: 'some/model',
      }).expect(200);
      const before = await storedKey(user);

      await put(user, {
        provider: 'openrouter',
        model: 'another/model',
        dataPolicy: 'no_training',
        priority: 3,
      }).expect(200);

      expect(await storedKey(user)).toBe(before);
      expect(await t.app.get(AiKeyService).savedKey(user.id, 'openrouter')).toBe('sk-or-first');
      expect(await listed(user)).toMatchObject([
        {
          provider: 'openrouter',
          model: 'another/model',
          dataPolicy: 'no_training',
          priority: 3,
          hasKey: true,
        },
      ]);
    });

    it('take a key entered with the change in place of the saved one', async () => {
      await put(user, {
        provider: 'openrouter',
        apiKey: 'sk-or-first',
        model: 'some/model',
      }).expect(200);

      await put(user, {
        provider: 'openrouter',
        apiKey: 'sk-or-second',
        model: 'some/model',
      }).expect(200);

      expect(await t.app.get(AiKeyService).savedKey(user.id, 'openrouter')).toBe('sk-or-second');
    });

    it('are refused without a key when there is none saved, at the field of the key', async () => {
      const refused = await put(user, { provider: 'openai', model: 'gpt-x' }).expect(400);

      expect(refused.body).toMatchObject(keyRequired);
      expect(await t.prisma.aiProviderConfig.count({ where: { userId: user.id } })).toBe(0);
    });

    it('are refused without a key when the saved one can no longer be read', async () => {
      await put(user, {
        provider: 'openrouter',
        apiKey: 'sk-or-first',
        model: 'some/model',
      }).expect(200);
      await t.prisma.aiProviderConfig.updateMany({
        where: { userId: user.id },
        data: { encryptedKey: 'damaged' },
      });

      const refused = await put(user, { provider: 'openrouter', model: 'another/model' }).expect(
        400,
      );

      expect(refused.body).toMatchObject(keyRequired);
      expect(await listed(user)).toMatchObject([{ model: 'some/model', keyUnreadable: true }]);
    });

    it("are never filled with another account's key", async () => {
      const other = await aUser(t);
      await put(other, {
        provider: 'openrouter',
        apiKey: 'sk-or-theirs',
        model: 'some/model',
      }).expect(200);

      const refused = await put(user, { provider: 'openrouter', model: 'some/model' }).expect(400);

      expect(refused.body).toMatchObject(keyRequired);
    });

    it('are tested with the saved key when the test leaves it out, and with none of Ollama', async () => {
      const probe = vi
        .spyOn(t.app.get(AiTestService), 'test')
        .mockResolvedValue({ ok: true, models: [], error: null, noRetentionProviders: null });
      await put(user, {
        provider: 'openrouter',
        apiKey: 'sk-or-first',
        model: 'some/model',
      }).expect(200);
      // A key saved with Ollama's entry is never sent with its test: the address is the request's.
      await put(user, {
        provider: 'ollama',
        baseUrl: t.model.url,
        apiKey: 'kept-with-ollama',
        model: 'local',
      }).expect(200);

      await t
        .http()
        .post('/api/ai/test')
        .set(as(user))
        .send({ provider: 'openrouter' })
        .expect(201);
      await t.http().post('/api/ai/test').set(as(user)).send({ provider: 'openai' }).expect(201);
      await t
        .http()
        .post('/api/ai/test')
        .set(as(user))
        .send({ provider: 'openrouter', apiKey: 'sk-or-typed' })
        .expect(201);
      await t
        .http()
        .post('/api/ai/test')
        .set(as(user))
        .send({ provider: 'ollama', baseUrl: t.model.url })
        .expect(201);

      expect(probe.mock.calls.map(([dto]) => [dto.provider, dto.apiKey])).toEqual([
        ['openrouter', 'sk-or-first'],
        // Nothing saved for OpenAI: the test says a key is needed.
        ['openai', undefined],
        ['openrouter', 'sk-or-typed'],
        ['ollama', undefined],
      ]);
    });
  });

  it("are each account's own: two accounts have one each for the same provider", async () => {
    const other = await aUser(t);
    await save(user, 'mine').expect(200);
    await save(other, 'theirs').expect(200);

    expect(await listed(user)).toMatchObject([{ model: 'mine' }]);
    expect(await listed(other)).toMatchObject([{ model: 'theirs' }]);
  });
});
