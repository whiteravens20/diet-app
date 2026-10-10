// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase } from '../testing/database.js';
import { aPrivateRecipe, aUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the numbers on the admin page', () => {
  let t: TestApp;
  const basic = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };
  const counts = async (): Promise<{ ingredients: number; recipes: number }> =>
    (await t.http().get('/api/admin/stats').set(basic).expect(200)).body.counts;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('count the catalogue, not what users made for themselves', async () => {
    const before = await counts();
    await aPrivateRecipe(t, await aUser(t));

    expect(await counts()).toEqual(before);
  });

  it('leave out what a catalogue update retired', async () => {
    const before = await counts();
    const recipe = await t.prisma.recipe.findFirstOrThrow({ where: { createdByUserId: null, retiredAt: null } });
    const ingredient = await t.prisma.ingredient.findFirstOrThrow({ where: { retiredAt: null } });
    await t.prisma.recipe.update({ where: { id: recipe.id }, data: { retiredAt: new Date() } });
    await t.prisma.ingredient.update({ where: { id: ingredient.id }, data: { retiredAt: new Date() } });

    expect(await counts()).toMatchObject({ recipes: before.recipes - 1, ingredients: before.ingredients - 1 });
  });
});
