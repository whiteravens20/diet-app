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

  it("are each account's own: two accounts have one each for the same provider", async () => {
    const other = await aUser(t);
    await save(user, 'mine').expect(200);
    await save(other, 'theirs').expect(200);

    expect(await listed(user)).toMatchObject([{ model: 'mine' }]);
    expect(await listed(other)).toMatchObject([{ model: 'theirs' }]);
  });
});
