// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { randomUUID } from 'node:crypto';
import { MAX_QUANTITY, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the pantry', () => {
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

  const ingredientId = async (slug: string): Promise<string> => (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;

  /** Add `quantity` of an ingredient to the pantry of `profile` as `user`. */
  const add = async (slug: string, quantity: number, unit: string, more: Record<string, unknown> = {}) =>
    t
      .http()
      .post('/api/inventory')
      .set(as(user))
      .send({ profileId: profile.id, ingredientId: await ingredientId(slug), quantity, unit, ...more });

  it('stores a row for a catalogue ingredient and adds to it on a second post', async () => {
    await add('rolled-oats', 300, 'g');
    const second = await add('rolled-oats', 300, 'g');

    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ quantity: 600, unit: 'g' });
    expect(await t.prisma.inventoryItem.count({ where: { profileId: profile.id } })).toBe(1);
  });

  it('keeps one ingredient in more than one unit, a row for each', async () => {
    await add('large-egg', 6, 'piece');
    await add('large-egg', 200, 'g');

    const rows = await t.http().get(`/api/inventory?profileId=${profile.id}`).set(as(user)).expect(200);

    expect(rows.body.map((row: { quantity: number; unit: string }) => `${row.quantity} ${row.unit}`).sort()).toEqual(['200 g', '6 piece']);
  });

  it('answers 404 when a row names an ingredient that does not exist', async () => {
    const res = await t
      .http()
      .post('/api/inventory')
      .set(as(user))
      .send({ profileId: profile.id, ingredientId: randomUUID(), quantity: 100, unit: 'g' })
      .expect(404);

    expect(res.body).toMatchObject({ error: 'INGREDIENT_NOT_FOUND' });
  });

  describe('what a row is shown as', () => {
    it('calls a piece what the ingredient calls it, and rounds what arithmetic left behind', async () => {
      const bread = await add('wholegrain-bread', 4, 'piece');
      const eggs = await add('large-egg', 6.5454, 'piece');
      const oats = await add('rolled-oats', 213.4, 'g');

      expect(bread.body.display).toEqual({ quantity: 4, unit: 'slice' });
      expect(eggs.body.display).toEqual({ quantity: 6.5, unit: 'piece' });
      expect(oats.body.display).toEqual({ quantity: 213, unit: 'g' });
      // The exact number stays what the row holds.
      expect(oats.body.quantity).toBe(213.4);
      expect(bread.body.ingredient.displayUnit).toBe('slice');
    });

    it('gives the best-before date as a date, keeps it when a later post leaves it out and replaces it when one names another', async () => {
      const first = await add('whole-milk', 500, 'ml', { bestBefore: '2026-11-05', note: 'opened' });
      const second = await add('whole-milk', 500, 'ml');
      const third = await add('whole-milk', 500, 'ml', { bestBefore: '2026-11-20', note: null });

      expect(first.body).toMatchObject({ bestBefore: '2026-11-05', note: 'opened' });
      expect(second.body).toMatchObject({ quantity: 1000, bestBefore: '2026-11-05', note: 'opened' });
      expect(third.body).toMatchObject({ quantity: 1500, bestBefore: '2026-11-20', note: null });
    });
  });

  describe('a quantity', () => {
    it.each([0, -5])('of %s is not something to add', async (quantity) => {
      expect((await add('rolled-oats', quantity, 'g')).status).toBe(400);
    });

    it('beyond what a row of its unit may hold is refused, whether in one post or added up', async () => {
      const tooManyEggs = await add('large-egg', MAX_QUANTITY.piece + 1, 'piece');
      expect(tooManyEggs.status).toBe(400);
      expect(tooManyEggs.body.error).toBe('QUANTITY_TOO_LARGE');
      expect((await add('rolled-oats', 1e308, 'g')).status).toBe(400);

      expect((await add('rolled-oats', MAX_QUANTITY.g, 'g')).status).toBe(201);
      const onTop = await add('rolled-oats', 1, 'g');
      expect(onTop.status).toBe(400);
      expect(onTop.body.error).toBe('QUANTITY_TOO_LARGE');
      expect((await t.prisma.inventoryItem.findFirstOrThrow({ where: { profileId: profile.id } })).quantity).toBe(MAX_QUANTITY.g);
    });

    it('in a unit the ingredient cannot be converted from is refused', async () => {
      // Rice has no weight per piece and no density.
      const pieces = await add('white-rice', 3, 'piece');
      const millilitres = await add('white-rice', 200, 'ml');

      expect(pieces.status).toBe(400);
      expect(pieces.body.error).toBe('UNIT_NOT_CONVERTIBLE');
      expect(millilitres.body.error).toBe('UNIT_NOT_CONVERTIBLE');
      expect(await t.prisma.inventoryItem.count()).toBe(0);
    });

    it('is the sum when two posts for a new row arrive at the same moment', async () => {
      const results = await race(4, () => add('rolled-oats', 100, 'g'));

      expect(results.map((result) => (result.status === 'fulfilled' ? result.value.status : 'threw'))).toEqual([201, 201, 201, 201]);
      const rows = await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id } });
      expect(rows.map((row) => row.quantity)).toEqual([400]);
    });
  });

  describe('a row that is there', () => {
    it('can be set to another quantity, zero included, and to no more than the ceiling', async () => {
      const row = (await add('rolled-oats', 300, 'g')).body as { id: string };

      const set = await t.http().patch(`/api/inventory/${row.id}`).set(as(user)).send({ quantity: 125 }).expect(200);
      const emptied = await t.http().patch(`/api/inventory/${row.id}`).set(as(user)).send({ quantity: 0 }).expect(200);
      const tooMuch = await t.http().patch(`/api/inventory/${row.id}`).set(as(user)).send({ quantity: MAX_QUANTITY.g + 1 });

      expect(set.body.quantity).toBe(125);
      expect(emptied.body.quantity).toBe(0);
      expect(tooMuch.status).toBe(400);
    });

    it('keeps what a patch does not name', async () => {
      const row = (await add('whole-milk', 500, 'ml', { bestBefore: '2026-11-05', note: 'opened' })).body as { id: string };

      const patched = await t.http().patch(`/api/inventory/${row.id}`).set(as(user)).send({ note: 'half left' }).expect(200);

      expect(patched.body).toMatchObject({ quantity: 500, bestBefore: '2026-11-05', note: 'half left' });
    });

    it('can be deleted, after which it is not found', async () => {
      const row = (await add('rolled-oats', 300, 'g')).body as { id: string };

      await t.http().delete(`/api/inventory/${row.id}`).set(as(user)).expect(204);

      const again = await t.http().patch(`/api/inventory/${row.id}`).set(as(user)).send({ quantity: 5 }).expect(404);
      expect(again.body.error).toBe('INVENTORY_ITEM_NOT_FOUND');
      await t.http().delete(`/api/inventory/${randomUUID()}`).set(as(user)).expect(404);
    });
  });

  describe("another user's pantry", () => {
    it('cannot be read, added to, changed or emptied', async () => {
      const row = (await add('rolled-oats', 300, 'g')).body as { id: string };
      const other = await aUser(t);

      await t.http().get(`/api/inventory?profileId=${profile.id}`).set(as(other)).expect(403);
      await t
        .http()
        .post('/api/inventory')
        .set(as(other))
        .send({ profileId: profile.id, ingredientId: await ingredientId('rolled-oats'), quantity: 1, unit: 'g' })
        .expect(403);
      await t.http().patch(`/api/inventory/${row.id}`).set(as(other)).send({ quantity: 1 }).expect(403);
      await t.http().delete(`/api/inventory/${row.id}`).set(as(other)).expect(403);

      expect((await t.prisma.inventoryItem.findUniqueOrThrow({ where: { id: row.id } })).quantity).toBe(300);
    });
  });
});
