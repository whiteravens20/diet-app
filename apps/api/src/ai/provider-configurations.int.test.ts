// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { AiProviderConfig } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

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

  it("are each account's own: two accounts have one each for the same provider", async () => {
    const other = await aUser(t);
    await save(user, 'mine').expect(200);
    await save(other, 'theirs').expect(200);

    expect(await listed(user)).toMatchObject([{ model: 'mine' }]);
    expect(await listed(other)).toMatchObject([{ model: 'theirs' }]);
  });
});
