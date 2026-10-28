// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { randomUUID } from 'node:crypto';
import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('an addition sent again with its key', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  /** Note `kg` for the profile as `who`, under `key` where one is given. */
  const weigh = (kg: number, key?: string, who: TestUser = user, profileId = profile.id) => {
    const request = t.http().post('/api/weights').set(as(who));
    if (key !== undefined) request.set('Idempotency-Key', key);
    return request.send({ profileId, kg, recordedAt: '2026-01-05T08:00:00.000Z' });
  };

  const weights = () => t.prisma.weightEntry.count({ where: { profileId: profile.id } });

  it('notes a weight once, and answers the request sent again with the entry the first one noted', async () => {
    const key = randomUUID();

    const first = await weigh(70.5, key);
    const again = await weigh(70.5, key);

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await weights()).toBe(1);
  });

  it('takes a key quoted as the IETF draft writes it for the same key unquoted', async () => {
    const key = randomUUID();

    await weigh(70.5, `"${key}"`).expect(201);
    await weigh(70.5, key).expect(201);

    expect(await weights()).toBe(1);
  });

  it('refuses another request under a key that was used, and writes nothing for it', async () => {
    const key = randomUUID();
    await weigh(70.5, key).expect(201);

    const other = await weigh(71, key);

    expect(other.status).toBe(422);
    expect(other.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await weights()).toBe(1);
  });

  it('writes a request without a key as it comes, every time', async () => {
    await weigh(70.5).expect(201);
    await weigh(70.5).expect(201);

    expect(await weights()).toBe(2);
  });

  it('writes once when the same request comes twice at the same moment, and answers both with what was written', async () => {
    const key = randomUUID();

    const both = await race(2, () => weigh(70.5, key));

    const answers = both.map((settled) => (settled.status === 'fulfilled' ? settled.value : null));
    expect(answers.map((answer) => answer?.status)).toEqual([201, 201]);
    expect(answers[0]?.body.id).toBe(answers[1]?.body.id);
    expect(await weights()).toBe(1);
  });

  it("keeps a key with its account: another account's request under it is its own", async () => {
    const key = randomUUID();
    const other = await aUser(t);
    const theirs = await aProfile(t, other);

    await weigh(70.5, key).expect(201);
    await weigh(70.5, key, other, theirs.id).expect(201);

    expect(await weights()).toBe(1);
    expect(await t.prisma.weightEntry.count({ where: { profileId: theirs.id } })).toBe(1);
  });

  it('answers the request sent again as what the first one wrote is now: an entry deleted since is not found', async () => {
    const key = randomUUID();
    const first = await weigh(70.5, key).expect(201);
    await t.http().delete(`/api/weights/${first.body.id}`).set(as(user)).expect(204);

    const again = await weigh(70.5, key);

    expect(again.status).toBe(404);
    expect(again.body.error).toBe('WEIGHT_ENTRY_NOT_FOUND');
    expect(await weights()).toBe(0);
  });

  it.each([
    ['', 'nothing'],
    ['a'.repeat(129), 'too much'],
    ['one two', 'a space'],
  ])('refuses the key %j, which holds %s, before anything is written', async (key) => {
    const refused = await weigh(70.5, key);

    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('VALIDATION_FAILED');
    expect(refused.body.issues[0].path).toBe('idempotency-key');
    expect(await weights()).toBe(0);
  });

  it('puts something into the pantry once, and answers the request sent again with its row as it is now', async () => {
    const key = randomUUID();
    const oats = await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'rolled-oats' } });
    const put = () =>
      t
        .http()
        .post('/api/inventory')
        .set(as(user))
        .set('Idempotency-Key', key)
        .send({ profileId: profile.id, ingredientId: oats.id, quantity: 300, unit: 'g' });

    const first = await put();
    const again = await put();

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: first.body.id, quantity: 300, unit: 'g' });
    expect(
      await t.prisma.inventoryItem.findMany({
        where: { profileId: profile.id },
        select: { quantity: true },
      }),
    ).toEqual([{ quantity: 300 }]);
  });

  it("adds a meal of one's own once, and answers the request sent again with the plan as it is now, without a rebalance", async () => {
    const key = randomUUID();
    const plan: MealPlan = await aPlan(t, user, profile);
    const day = plan.days[1]!;
    const add = () =>
      t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${day.date}/custom-meal`)
        .set(as(user))
        .set('Idempotency-Key', key)
        .send({
          name: 'Birthday cake',
          mealType: 'snack',
          nutrition: { calories: 420, protein: 5, fat: 20, carbs: 55 },
          servings: 1,
        });

    const first = await add();
    const again = await add();

    expect(first.status).toBe(201);
    expect(first.body.rebalance).not.toBeNull();
    expect(again.status).toBe(201);
    expect(again.body.rebalance).toBeNull();
    expect(again.body.plan.revision).toBe(first.body.plan.revision);
    expect(
      await t.prisma.plannedMeal.count({
        where: { day: { planId: plan.id }, source: 'USER_CUSTOM' },
      }),
    ).toBe(1);
  });
});
