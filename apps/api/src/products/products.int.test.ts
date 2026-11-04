// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { DiaryEntry, Product } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, as, aUser, type TestUser } from '../testing/factories.js';
import {
  startFakeOpenFoodFacts,
  type FakeOpenFoodFacts,
  type ProductAnswer,
} from '../testing/fake-open-food-facts.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ProductsService } from './products.service.js';
import { PRODUCT_LOOKUPS } from './limits.js';

const MILK = '5900512320359';
const OTHER = '4001724819806';
const DAY = 86_400_000;
/** The day `offset` days from today: the API takes a client's date only near its own. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const TODAY = day(0);
const YESTERDAY = day(-1);

/** A code of its own for each number: all of them close with their last digit. */
function codeOf(n: number): string {
  const body = `59000${String(n).padStart(7, '0')}`;
  const sum = [...body]
    .reverse()
    .reduce((all, digit, place) => all + Number(digit) * (place % 2 === 0 ? 3 : 1), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** An answer of Open Food Facts, as it words a product. */
const MILK_SAID: ProductAnswer = {
  code: MILK,
  product_name: 'Mleko WYPASIONE 3,2%',
  brands: 'Mlekovita',
  quantity: '1l',
  product_quantity: 1000,
  serving_quantity: 250,
  nutrition_data_per: '100ml',
  last_modified_t: 1787927571,
  unique_scans_n: 5,
  nutriments: {
    'energy-kcal_100g': 60,
    'energy-kj_100g': 252.7,
    proteins_100g: 3.2,
    fat_100g: 3.2,
    carbohydrates_100g: 4.7,
    sugars_100g: 4.7,
    salt_100g: 0.0975,
    'saturated-fat_100g': 2.1,
  },
};

describe('the products an account can read', () => {
  let t: TestApp;
  let off: FakeOpenFoodFacts;
  let user: TestUser;

  const byCode = (code: string, who: TestUser = user) =>
    t.http().get(`/api/products/code/${code}`).set(as(who));

  beforeAll(async () => {
    off = await startFakeOpenFoodFacts();
    t = await createTestApp({
      OPEN_FOOD_FACTS_URL: off.url,
      OPEN_FOOD_FACTS_EXPORT_URL: off.exportUrl,
      OPERATOR_CONTACT: 'operator@example.org',
    });
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
    await off.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    await t.prisma.product.deleteMany();
    await t.prisma.productCodeUnknown.deleteMany();
    await t.prisma.productLookup.deleteMany();
    off.asked.length = 0;
    off.answers = new Map([[MILK, MILK_SAID]]);
    user = await aUser(t);
  });

  describe('by a code', () => {
    it('asks Open Food Facts about one the instance does not hold, in its own name', async () => {
      const answer = await byCode(MILK).expect(200);

      expect(answer.body as Product).toMatchObject({
        code: MILK,
        name: 'Mleko WYPASIONE 3,2%',
        brand: 'Mlekovita',
        pack: '1l',
        unit: 'ml',
        packAmount: 1000,
        servingAmount: 250,
        per100: { calories: 60, protein: 3.2, fat: 3.2, carbs: 4.7, salt: 0.1, fiber: null },
        energyWorkedOut: false,
        doubtful: false,
      });
      expect(off.asked).toHaveLength(1);
      const headers = off.asked[0]!.headers;
      expect(headers['user-agent']).toMatch(/^DietApp\/\S+ \(operator@example\.org\)$/);
      // Nothing of whoever asked goes with it.
      expect(JSON.stringify(headers)).not.toContain(user.accessToken);
      expect(JSON.stringify(headers)).not.toContain(user.email);
      expect(Object.keys(headers).sort()).toEqual(['accept', 'connection', 'host', 'user-agent']);
    });

    it('keeps what it heard for everybody, and asks about it once', async () => {
      await byCode(MILK).expect(200);
      await byCode(MILK, await aUser(t)).expect(200);
      expect(off.asked).toHaveLength(1);
      expect(await t.prisma.product.findUnique({ where: { code: MILK } })).toMatchObject({
        origin: 'looked_up',
      });
    });

    it('takes a code however it is written, and asks in the form Open Food Facts keeps', async () => {
      off.answers.set('0036000291452', { ...MILK_SAID, code: '0036000291452' });
      const answer = await byCode('036000291452').expect(200);
      expect(answer.body.code).toBe('0036000291452');
      expect(off.asked[0]?.code).toBe('0036000291452');
    });

    it.each([
      ['a last digit that does not close it', '5900512320358'],
      ['too few digits', '12345'],
      ['letters', '59005123abc59'],
    ])('refuses %s, and asks nobody', async (_, code) => {
      const answer = await byCode(code).expect(400);
      expect(answer.body.error).toBe('VALIDATION_FAILED');
      expect(off.asked).toHaveLength(0);
    });

    it('needs an account', async () => {
      await t.http().get(`/api/products/code/${MILK}`).expect(401);
      expect(off.asked).toHaveLength(0);
    });

    it('says that a code is not known, and does not ask again for a week', async () => {
      const answer = await byCode(OTHER).expect(404);
      expect(answer.body.error).toBe('PRODUCT_NOT_FOUND');
      await byCode(OTHER, await aUser(t)).expect(404);
      expect(off.asked).toHaveLength(1);

      await t.prisma.productCodeUnknown.update({
        where: { code: OTHER },
        data: { askedAt: new Date(Date.now() - 8 * DAY) },
      });
      await byCode(OTHER).expect(404);
      expect(off.asked).toHaveLength(2);
    });

    it('finds a code it took as unknown once Open Food Facts knows it', async () => {
      await byCode(OTHER).expect(404);
      off.answers.set(OTHER, { ...MILK_SAID, code: OTHER });
      await t.prisma.productCodeUnknown.update({
        where: { code: OTHER },
        data: { askedAt: new Date(Date.now() - 8 * DAY) },
      });
      await byCode(OTHER).expect(200);
      expect(await t.prisma.productCodeUnknown.count()).toBe(0);
    });

    it('takes a product without a name as unknown', async () => {
      off.answers.set(OTHER, { ...MILK_SAID, code: OTHER, product_name: ' ' });
      await byCode(OTHER).expect(404);
      expect(await t.prisma.product.count()).toBe(0);
    });

    it('answers with a product whose label gives no figures, as one', async () => {
      off.answers.set(OTHER, { code: OTHER, product_name: 'Bez etykiety', nutriments: {} });
      const answer = await byCode(OTHER).expect(200);
      expect(answer.body.per100.calories).toBeNull();
      expect(answer.body.name).toBe('Bez etykiety');
    });

    it('goes by what it heard for a month, then asks again', async () => {
      await byCode(MILK).expect(200);
      await t.prisma.product.update({
        where: { code: MILK },
        data: { readAt: new Date(Date.now() - 29 * DAY) },
      });
      await byCode(MILK).expect(200);
      expect(off.asked).toHaveLength(1);

      await t.prisma.product.update({
        where: { code: MILK },
        data: { readAt: new Date(Date.now() - 31 * DAY) },
      });
      off.answers.set(MILK, { ...MILK_SAID, product_name: 'Mleko nowe' });
      expect((await byCode(MILK).expect(200)).body.name).toBe('Mleko nowe');
      expect(off.asked).toHaveLength(2);
    });

    it('forgets a product Open Food Facts no longer knows', async () => {
      await byCode(MILK).expect(200);
      await t.prisma.product.update({
        where: { code: MILK },
        data: { readAt: new Date(Date.now() - 31 * DAY) },
      });
      off.answers.delete(MILK);
      await byCode(MILK).expect(404);
      expect(await t.prisma.product.count()).toBe(0);
    });

    it('never asks about what the import brought, however old', async () => {
      await t.prisma.product.create({
        data: {
          code: MILK,
          name: 'Z importu',
          searchText: 'z importu',
          unit: 'g',
          calories: 50,
          origin: 'imported',
          readAt: new Date(Date.now() - 400 * DAY),
        },
      });
      expect((await byCode(MILK).expect(200)).body.name).toBe('Z importu');
      expect(off.asked).toHaveLength(0);
    });

    describe('where Open Food Facts gives no answer', () => {
      it.each([429, 500, 503])('says so at %i, and remembers nothing', async (status) => {
        off.answers.set(OTHER, status);
        const answer = await byCode(OTHER).expect(503);
        expect(answer.body.error).toBe('PRODUCT_SOURCE_UNAVAILABLE');
        expect(await t.prisma.productCodeUnknown.count()).toBe(0);
      });

      it('goes by what it heard before', async () => {
        await byCode(MILK).expect(200);
        await t.prisma.product.update({
          where: { code: MILK },
          data: { readAt: new Date(Date.now() - 31 * DAY) },
        });
        off.answers.set(MILK, 503);
        expect((await byCode(MILK).expect(200)).body.name).toBe('Mleko WYPASIONE 3,2%');
      });
    });
  });

  describe('holds what is asked of Open Food Facts to its limits', () => {
    const service = () => t.app.get(ProductsService);

    it('an account, to a few a minute', async () => {
      const now = new Date();
      for (let n = 0; n < PRODUCT_LOOKUPS.accountMinute; n += 1) {
        await service()
          .byCode(user.id, codeOf(n), now)
          .catch((err: { status?: number }) => expect(err.status).toBe(404));
      }
      await expect(service().byCode(user.id, codeOf(100), now)).rejects.toMatchObject({
        status: 429,
        response: { error: 'PRODUCT_LOOKUPS_BUSY' },
      });
      expect(off.asked).toHaveLength(PRODUCT_LOOKUPS.accountMinute);
      // A minute later it may ask again.
      await expect(
        service().byCode(user.id, codeOf(100), new Date(now.getTime() + 61_000)),
      ).rejects.toMatchObject({ response: { error: 'PRODUCT_NOT_FOUND' } });
    });

    it('the instance, to under what Open Food Facts allows one address, whoever asks', async () => {
      const now = new Date();
      const others = await Promise.all(
        Array.from({ length: PRODUCT_LOOKUPS.instanceMinute }, () => aUser(t)),
      );
      const answers = await Promise.allSettled(
        [...others, await aUser(t), await aUser(t)].map((who, n) =>
          service().byCode(who.id, codeOf(n), now),
        ),
      );
      const busy = answers.filter(
        (answer) =>
          answer.status === 'rejected' &&
          (answer.reason as { response?: { error?: string } }).response?.error ===
            'PRODUCT_LOOKUPS_BUSY',
      );
      expect(busy).toHaveLength(2);
      expect(off.asked).toHaveLength(PRODUCT_LOOKUPS.instanceMinute);
    });

    it('an account, to a hundred a day, by day and not by what was found', async () => {
      const now = new Date();
      await t.prisma.productLookup.createMany({
        data: Array.from({ length: PRODUCT_LOOKUPS.accountDay }, (_, n) => ({
          userId: user.id,
          at: new Date(now.getTime() - 3_600_000 - n * 1000),
        })),
      });
      await expect(service().byCode(user.id, MILK, now)).rejects.toMatchObject({
        status: 429,
        response: { error: 'PRODUCT_LOOKUPS_USED_UP' },
      });
      expect(off.asked).toHaveLength(0);
      // Somebody else is not held to it.
      const other = await aUser(t);
      await expect(service().byCode(other.id, MILK, now)).resolves.toMatchObject({ code: MILK });
    });

    it('and counts nothing the instance answers by itself', async () => {
      const now = new Date();
      await service().byCode(user.id, MILK, now);
      await service()
        .byCode(user.id, OTHER, now)
        .catch(() => undefined);
      for (let n = 0; n < 20; n += 1) {
        await service().byCode(user.id, MILK, now);
        await service()
          .byCode(user.id, OTHER, now)
          .catch(() => undefined);
      }
      expect(await t.prisma.productLookup.count({ where: { userId: user.id } })).toBe(2);
    });

    it('keeps no code with an account', async () => {
      await byCode(MILK).expect(200);
      const row = await t.prisma.productLookup.findFirstOrThrow();
      expect(JSON.stringify(row)).not.toContain(MILK);
    });

    it('still gives what it heard before to one whose limit is used up', async () => {
      const now = new Date();
      await service().byCode(user.id, MILK, now);
      await t.prisma.product.update({
        where: { code: MILK },
        data: { readAt: new Date(now.getTime() - 31 * DAY) },
      });
      await t.prisma.productLookup.createMany({
        data: Array.from({ length: PRODUCT_LOOKUPS.accountDay }, () => ({
          userId: user.id,
          at: new Date(now.getTime() - 3_600_000),
        })),
      });
      await expect(service().byCode(user.id, MILK, now)).resolves.toMatchObject({ code: MILK });
    });
  });

  describe('by words', () => {
    const search = (words: string, who: TestUser = user) =>
      t.http().get('/api/products').query({ search: words }).set(as(who));
    const names = async (words: string) =>
      ((await search(words).expect(200)).body.items as Product[]).map((item) => item.name);
    const held = (code: string, name: string, more: object = {}) =>
      t.prisma.product.create({
        data: {
          code,
          name,
          searchText: name.toLowerCase(),
          unit: 'g',
          calories: 100,
          origin: 'imported',
          ...more,
        },
      });

    it('finds what holds every word, by a part of it, the most scanned first', async () => {
      await held(codeOf(1), 'Mleko Laciate', { popularity: 1 });
      await held(codeOf(2), 'Mleko Wiejskie', { popularity: 9 });
      await held(codeOf(3), 'Maslo Laciate', { popularity: 5 });
      expect(await names('mleko')).toEqual(['Mleko Wiejskie', 'Mleko Laciate']);
      expect(await names('leko lac')).toEqual(['Mleko Laciate']);
      expect(await names('Laciate')).toEqual(['Maslo Laciate', 'Mleko Laciate']);
    });

    it('puts what holds a word in its name before what holds it only in its brand', async () => {
      await held(codeOf(1), 'Butter', { searchText: 'butter | mlekovita', popularity: 900 });
      await held(codeOf(2), 'Coca-Cola Mleko', { searchText: 'coca cola mleko', popularity: 3 });
      await held(codeOf(3), 'Mleko UHT', { searchText: 'mleko uht | laciate', popularity: 7 });
      expect(await names('mleko')).toEqual(['Mleko UHT', 'Coca-Cola Mleko', 'Butter']);
      // Every word has to stand in the name for it to count as one of those.
      expect(await names('mleko laciate')).toEqual(['Mleko UHT']);
    });

    it('reads no diacritics and no capitals, as it reads the names', async () => {
      await t.prisma.product.create({
        data: {
          code: codeOf(1),
          name: 'Żubrówka Łącka',
          searchText: 'zubrowka lacka',
          unit: 'g',
          calories: 100,
          origin: 'imported',
        },
      });
      expect(await names('ŻUBRÓWKA')).toEqual(['Żubrówka Łącka']);
      expect(await names('lacka')).toEqual(['Żubrówka Łącka']);
    });

    it.each([
      ['Cyrillic', 'молоко домик', 'молоко'],
      ['Greek', 'γαλα φαγε', 'γαλα'],
      ['Hebrew', 'חלב תנובה', 'תנובה'],
      ['Thai', 'นมสด', 'นมส'],
      ['Japanese', '牛乳 おいしい', '牛乳'],
      ['Korean', '서울 우유', '우유'],
    ])('finds a word in %s', async (_, name, word) => {
      await held(codeOf(1), name);
      expect(await names(word)).toEqual([name]);
    });

    it('offers only what can be written into a diary', async () => {
      await held(codeOf(1), 'Mleko bez etykiety', { calories: null });
      await held(codeOf(2), 'Mleko z etykieta');
      expect(await names('mleko')).toEqual(['Mleko z etykieta']);
    });

    it('never asks anybody', async () => {
      await names('mleko');
      expect(off.asked).toHaveLength(0);
    });

    it('finds nothing in signs that mean something else in a pattern', async () => {
      await held(codeOf(1), 'Mleko');
      expect(await names('%%%')).toEqual([]);
      expect(await names('___')).toEqual([]);
      expect(await names("'; DROP")).toEqual([]);
    });

    it('takes no word too short for its index, and says nothing wrong of it', async () => {
      await held(codeOf(1), 'Ab cd');
      expect(await names('ab')).toEqual([]);
      await search('a').expect(400);
    });

    it('gives at most twenty', async () => {
      await t.prisma.product.createMany({
        data: Array.from({ length: 25 }, (_, n) => ({
          code: codeOf(n),
          name: `Mleko ${n}`,
          searchText: `mleko ${n}`,
          unit: 'g' as const,
          calories: 100,
          origin: 'imported' as const,
        })),
      });
      expect(await names('mleko')).toHaveLength(20);
    });

    it('needs an account', async () => {
      await t.http().get('/api/products').query({ search: 'mleko' }).expect(401);
    });
  });

  describe('in a diary', () => {
    let profileId: string;

    const write = (body: object, who: TestUser = user) =>
      t
        .http()
        .post('/api/diary/entries')
        .set(as(who))
        .set('X-Client-Date', TODAY)
        .send({ profileId, date: TODAY, mealType: 'snack', kind: 'product', ...body });

    const aProduct = (more: object = {}) =>
      t.prisma.product.create({
        data: {
          code: MILK,
          name: 'Mleko',
          brand: 'Mlekovita',
          searchText: 'mleko mlekovita',
          unit: 'ml',
          calories: 60,
          protein: 3.2,
          fat: 3.2,
          carbs: 4.7,
          sugars: 4.7,
          salt: 0.1,
          origin: 'imported',
          ...more,
        },
      });

    beforeEach(async () => {
      profileId = (await aProfile(t, user)).id;
    });

    it('is written in an amount, with what its label says', async () => {
      const product = await aProduct();
      const answer = await write({ productId: product.id, quantity: 250 }).expect(201);
      expect(answer.body as DiaryEntry).toMatchObject({
        kind: 'product',
        productId: product.id,
        name: 'Mleko, Mlekovita',
        servings: null,
        amount: { quantity: 250, unit: 'ml', shown: { quantity: 250, unit: 'ml' } },
        nutrition: { calories: 150, protein: 8, fat: 8, carbs: 12 },
        label: { fiber: null, sugars: 11.8, salt: 0.3, saturatedFat: null },
        estimated: false,
      });
    });

    it('counts in the day as anything else eaten', async () => {
      const product = await aProduct();
      await write({ productId: product.id, quantity: 250 }).expect(201);
      const day = await t
        .http()
        .get('/api/diary/day')
        .set(as(user))
        .query({ profileId, date: TODAY })
        .expect(200);
      expect(day.body.eaten.calories).toBe(150);
    });

    it('keeps its figures and its name when the product changes or goes', async () => {
      const product = await aProduct();
      const written = await write({ productId: product.id, quantity: 100 }).expect(201);
      await t.prisma.product.update({
        where: { id: product.id },
        data: { calories: 999, name: 'Inne' },
      });
      const day = async () =>
        (
          await t
            .http()
            .get('/api/diary/day')
            .set(as(user))
            .query({ profileId, date: TODAY })
            .expect(200)
        ).body.entries[0] as DiaryEntry;
      expect(await day()).toMatchObject({ name: 'Mleko, Mlekovita', nutrition: { calories: 60 } });

      await t.prisma.product.delete({ where: { id: product.id } });
      expect(await day()).toMatchObject({
        id: written.body.id,
        productId: null,
        name: 'Mleko, Mlekovita',
        nutrition: { calories: 60 },
        label: { sugars: 4.7 },
      });
    });

    it('estimates what the label lacks, and says so', async () => {
      const product = await aProduct({ protein: null, fat: null, carbs: null });
      const answer = await write({ productId: product.id, quantity: 100 }).expect(201);
      expect(answer.body.estimated).toBe(true);
      expect(answer.body.nutrition.calories).toBe(60);
      const { protein, fat, carbs } = answer.body.nutrition as Record<string, number>;
      expect(protein! * 4 + fat! * 9 + carbs! * 4).toBeGreaterThan(50);
    });

    it('takes a label that does not add up, with what it says', async () => {
      const product = await aProduct({
        calories: 176,
        protein: 8,
        fat: 20,
        carbs: 62,
        doubtful: true,
      });
      const answer = await write({ productId: product.id, quantity: 100 }).expect(201);
      expect(answer.body.nutrition).toEqual({ calories: 176, protein: 8, fat: 20, carbs: 62 });
      expect(answer.body.estimated).toBe(false);
    });

    it('refuses a product without energy, and says what to do', async () => {
      const product = await aProduct({ calories: null });
      const answer = await write({ productId: product.id, quantity: 100 }).expect(409);
      expect(answer.body.error).toBe('PRODUCT_WITHOUT_FIGURES');
    });

    it('refuses a product that is not there', async () => {
      const answer = await write({
        productId: '11111111-1111-4111-8111-111111111111',
        quantity: 100,
      }).expect(404);
      expect(answer.body.error).toBe('PRODUCT_NOT_FOUND');
    });

    it.each([0, -1, 5001])('refuses an amount of %s', async (quantity) => {
      const product = await aProduct();
      await write({ productId: product.id, quantity }).expect(400);
    });

    it('changes its figures in proportion to its amount, what the label says included', async () => {
      const product = await aProduct();
      const written = await write({ productId: product.id, quantity: 100 }).expect(201);
      const changed = await t
        .http()
        .patch(`/api/diary/entries/${written.body.id}`)
        .set(as(user))
        .send({ quantity: 200 })
        .expect(200);
      expect(changed.body).toMatchObject({
        amount: { quantity: 200, unit: 'ml' },
        nutrition: { calories: 120 },
        label: { sugars: 9.4, salt: 0.2 },
      });
    });

    it('takes no servings', async () => {
      const product = await aProduct();
      const written = await write({ productId: product.id, quantity: 100 }).expect(201);
      await t
        .http()
        .patch(`/api/diary/entries/${written.body.id}`)
        .set(as(user))
        .send({ servings: 2 })
        .expect(400);
    });

    it('is copied to another day whole', async () => {
      const product = await aProduct();
      await write({ productId: product.id, quantity: 250 }).expect(201);
      const copy = await t
        .http()
        .post('/api/diary/copy')
        .set(as(user))
        .set('X-Client-Date', TODAY)
        .send({ profileId, from: TODAY, to: YESTERDAY })
        .expect(201);
      expect(copy.body.day.entries[0]).toMatchObject({
        kind: 'product',
        productId: product.id,
        amount: { quantity: 250, unit: 'ml' },
        label: { sugars: 11.8 },
      });
    });

    it('goes into the account export, with what the label says', async () => {
      const product = await aProduct();
      await write({ productId: product.id, quantity: 250 }).expect(201);
      const file = await t.http().get('/api/users/me/export').set(as(user)).expect(200);
      expect(file.body.diary[0]).toMatchObject({
        kind: 'product',
        productId: product.id,
        quantity: 250,
        unit: 'ml',
        label: { sugars: 11.75, fiber: null },
      });
    });
  });

  it('are said to be offered, and looked up, in what a page reads first', async () => {
    const config = await t.http().get('/api/config').expect(200);
    expect(config.body.products).toEqual({ offered: true, lookups: true });
  });
});
