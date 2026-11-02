// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { as, asAdmin, aUser } from '../testing/factories.js';
import { startFakeOpenFoodFacts, type FakeOpenFoodFacts } from '../testing/fake-open-food-facts.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ProductImport } from './product-import.js';

const MILK = '5900512320359';

describe('an instance whose operator switched lookups off and named no country', () => {
  let t: TestApp;
  let off: FakeOpenFoodFacts;

  beforeAll(async () => {
    off = await startFakeOpenFoodFacts();
    t = await createTestApp({
      OPEN_FOOD_FACTS_URL: off.url,
      OPEN_FOOD_FACTS_EXPORT_URL: off.exportUrl,
      OPEN_FOOD_FACTS_LOOKUPS: 'false',
    });
  });

  afterAll(async () => {
    await t.close();
    await off.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    off.asked.length = 0;
    off.exportReads = 0;
  });

  it('offers no product', async () => {
    const config = await t.http().get('/api/config').expect(200);
    expect(config.body.products).toEqual({ offered: false, lookups: false });
  });

  it('asks nobody about a code', async () => {
    const user = await aUser(t);
    off.answers.set(MILK, { code: MILK, product_name: 'Mleko' });
    const answer = await t.http().get(`/api/products/code/${MILK}`).set(as(user)).expect(404);
    expect(answer.body.error).toBe('PRODUCT_NOT_FOUND');
    expect(off.asked).toHaveLength(0);
    expect(await t.prisma.productLookup.count()).toBe(0);
  });

  it('still reads what it holds, however old', async () => {
    const user = await aUser(t);
    await t.prisma.product.create({
      data: {
        code: MILK,
        name: 'Z dawna',
        searchText: 'z dawna',
        unit: 'g',
        origin: 'looked_up',
        readAt: new Date(0),
      },
    });
    const answer = await t.http().get(`/api/products/code/${MILK}`).set(as(user)).expect(200);
    expect(answer.body.name).toBe('Z dawna');
    expect(off.asked).toHaveLength(0);
  });

  it('imports nothing, at no hour, and says why it will not when asked', async () => {
    const products = t.app.get(ProductImport);
    expect(await products.due(new Date(2026, 10, 2, 3, 0, 0))).toBe(false);
    expect(await products.run()).toBe(false);
    expect(off.exportReads).toBe(0);

    const refused = await t.http().post('/api/admin/products/import').set(asAdmin).expect(409);
    expect(refused.body.error).toBe('PRODUCT_IMPORT_NO_COUNTRIES');
    const panel = await t.http().get('/api/admin/products').set(asAdmin).expect(200);
    expect(panel.body).toMatchObject({ lookups: false, countries: [], askedAt: null });
    expect(panel.body.import.status).toBe('idle');
  });
});

describe('an instance whose settings hold a country with something wrong', () => {
  it.each([
    ['capitals', 'Poland'],
    ['a tag written whole', 'en:poland'],
    ['an empty place in the list', 'poland,,germany'],
  ])('does not start on %s', async (_, value) => {
    const { envSchema } = await import('../config/env.js');
    expect(envSchema.shape.OPEN_FOOD_FACTS_COUNTRIES.safeParse(value).success).toBe(false);
  });

  it('takes a list however it is spaced, each country once', async () => {
    const { envSchema } = await import('../config/env.js');
    const field = envSchema.shape.OPEN_FOOD_FACTS_COUNTRIES;
    expect(field.parse(' poland , united-kingdom,poland ')).toEqual(['poland', 'united-kingdom']);
    expect(field.parse(undefined)).toEqual([]);
  });
});
