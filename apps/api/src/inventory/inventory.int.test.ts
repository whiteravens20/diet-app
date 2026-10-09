// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase } from '../testing/database.js';
import { aProfile, aUser, as } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the pantry', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('stores a row for a catalogue ingredient and adds to it on a second post', async () => {
    const user = await aUser(t);
    const profile = await aProfile(t, user);
    const oats = await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'rolled-oats' } });
    const row = { profileId: profile.id, ingredientId: oats.id, quantity: 300, unit: 'g' };

    await t.http().post('/api/inventory').set(as(user)).send(row).expect(201);
    const second = await t.http().post('/api/inventory').set(as(user)).send(row).expect(201);

    expect(second.body).toMatchObject({ quantity: 600, unit: 'g' });
    expect(await t.prisma.inventoryItem.count({ where: { profileId: profile.id } })).toBe(1);
  });

  it('answers 404 when a row names an ingredient that does not exist', async () => {
    const user = await aUser(t);
    const profile = await aProfile(t, user);

    const res = await t
      .http()
      .post('/api/inventory')
      .set(as(user))
      .send({ profileId: profile.id, ingredientId: randomUUID(), quantity: 100, unit: 'g' })
      .expect(404);

    expect(res.body).toMatchObject({ error: 'INGREDIENT_NOT_FOUND' });
  });
});
