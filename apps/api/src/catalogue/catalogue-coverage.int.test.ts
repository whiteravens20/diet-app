// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { DietType, MEAL_SLOTS_BY_COUNT, MealType, fitsDiet } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPrivateRecipe, aUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { CatalogueCoverageService } from './catalogue-coverage.service.js';

describe('what the catalogue can serve', () => {
  let t: TestApp;
  const basic = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };

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
    await t.prisma.recipe.updateMany({ data: { retiredAt: null } });
    await t.app.get(CatalogueCoverageService).count();
  });

  /** The same count, straight from the rows a plan may use. */
  const counted = async (diet: DietType, meal: MealType): Promise<number> => {
    const shared = await t.prisma.recipe.findMany({ where: { createdByUserId: null, retiredAt: null, deletedAt: null }, select: { dietTags: true, mealTypes: true } });
    return shared.filter((r) => r.mealTypes.includes(meal) && fitsDiet(r.dietTags, diet)).length;
  };

  it('is published for every diet and number of meals: the recipes the thinnest meal can choose from', async () => {
    const { depth } = (await t.http().get('/api/config').expect(200)).body.catalogue;

    for (const diet of DietType.options) {
      for (const [count, meals] of Object.entries(MEAL_SLOTS_BY_COUNT)) {
        const thinnest = Math.min(...(await Promise.all(meals.map((meal) => counted(diet, meal)))));
        expect(depth[diet][count], `${diet}, ${count} meals`).toBe(thinnest);
      }
    }
    expect(depth.balanced['3']).toBeGreaterThan(0);
  });

  it('is shown to the administrator meal by meal', async () => {
    const { coverage } = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body;

    expect(coverage.vegan.lunch).toBe(await counted('vegan', 'lunch'));
    expect(Object.keys(coverage.balanced).sort()).toEqual([...MealType.options].sort());
  });

  it('leaves out what a user made for themselves', async () => {
    const before = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body.coverage;
    await aPrivateRecipe(t, await aUser(t), { mealTypes: ['lunch'] });

    const after = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body.coverage;

    expect(await t.prisma.recipe.count({ where: { createdByUserId: { not: null }, mealTypes: { has: 'lunch' }, dietTags: { has: 'vegan' } } })).toBe(1);
    expect(after).toEqual(before);
  });

  it('leaves out what an update retired, and is read anew once a minute or when the administrator looks', async () => {
    const before = (await t.http().get('/api/config')).body.catalogue.depth;
    const dinners = await t.prisma.recipe.findMany({ where: { createdByUserId: null, mealTypes: { has: 'dinner' } }, select: { id: true } });
    await t.prisma.recipe.updateMany({ where: { id: { in: dinners.map((r) => r.id) } }, data: { retiredAt: new Date() } });

    // Kept for a minute: the public configuration is asked for on every page.
    expect((await t.http().get('/api/config')).body.catalogue.depth).toEqual(before);
    // The administrator's statistics count anew, and what they found is what is published from then on.
    const { coverage } = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body;
    const after = (await t.http().get('/api/config')).body.catalogue.depth;

    expect(before.balanced['2']).toBeGreaterThan(0);
    expect(coverage.balanced.dinner).toBe(0);
    expect(after.balanced['2']).toBe(0);
    expect(after.balanced['3']).toBe(0);
  });


});
