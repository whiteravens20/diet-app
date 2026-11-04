// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { gzipSync } from 'node:zlib';
import type { AdminProducts } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aProfile, as, asAdmin, aUser } from '../testing/factories.js';
import {
  EXPORT_COLUMNS,
  exportText,
  packedExport,
  startFakeOpenFoodFacts,
  type ExportRow,
  type FakeOpenFoodFacts,
} from '../testing/fake-open-food-facts.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ProductImport } from './product-import.js';

const POLISH = '5900512320359';
const GERMAN = '4001724819806';
const BOTH = '5901234123457';
const FRENCH = '3274080005003';

/** A product the import keeps, of the countries named. */
const row = (code: string, countries: string, name = `Produkt ${code}`): ExportRow => ({
  code,
  product_name: name,
  brands: 'Marka',
  quantity: '500 g',
  serving_quantity: 30,
  countries_tags: countries,
  last_modified_t: 1787927571,
  unique_scans_n: 3,
  'energy-kcal_100g': 60,
  proteins_100g: 3.2,
  fat_100g: 3.2,
  carbohydrates_100g: 4.7,
  sugars_100g: 4.7,
  salt_100g: 0.1,
});

/** At night by the worker's clock, in the instance's time zone. */
const NIGHT = new Date(2026, 10, 2, 3, 0, 0);
const HOUR = 3_600_000;
const TODAY = new Date().toISOString().slice(0, 10);

describe('the import of products', () => {
  let t: TestApp;
  let off: FakeOpenFoodFacts;
  let products: ProductImport;
  const held = (code: string) => t.prisma.product.findUnique({ where: { code } });
  const state = async () => (await products.overview(NIGHT)).import;

  beforeAll(async () => {
    off = await startFakeOpenFoodFacts();
    t = await createTestApp({
      OPEN_FOOD_FACTS_URL: off.url,
      OPEN_FOOD_FACTS_EXPORT_URL: off.exportUrl,
      OPEN_FOOD_FACTS_COUNTRIES: 'poland, germany',
    });
    products = t.app.get(ProductImport);
  });

  afterAll(async () => {
    await t.close();
    await off.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    off.exportReads = 0;
    off.exportBytes = packedExport([
      row(POLISH, 'en:poland', 'Mleko Łaciate'),
      row(GERMAN, 'en:germany'),
      row(BOTH, 'en:poland,en:germany'),
      row(FRENCH, 'en:france'),
    ]);
  });

  describe('keeps of the export', () => {
    it('the products of the countries named, and says how many each brought', async () => {
      expect(await products.run(NIGHT)).toBe(true);

      expect(await t.prisma.product.count()).toBe(3);
      expect(await held(FRENCH)).toBeNull();
      expect(await held(POLISH)).toMatchObject({
        name: 'Mleko Łaciate',
        brand: 'Marka',
        searchText: 'mleko laciate | marka',
        origin: 'imported',
        unit: 'g',
        packAmount: 500,
        servingAmount: 30,
        calories: 60,
        salt: 0.1,
        fiber: null,
        doubtful: false,
      });
      expect(await state()).toMatchObject({
        status: 'done',
        countries: ['poland', 'germany'],
        perCountry: { poland: 2, germany: 2 },
        read: 4,
        added: 3,
        changed: 0,
        removed: 0,
      });
    });

    it('no product of another country that only looks like one of those named', async () => {
      off.exportBytes = packedExport([
        row(POLISH, 'en:poland'),
        // The words of a country elsewhere in the row, and a tag that begins like one.
        row(FRENCH, 'en:polandia,en:france', 'Wyglada jak en:poland'),
      ]);
      await products.run(NIGHT);
      expect(await held(FRENCH)).toBeNull();
    });

    it('nothing of a row without a usable code, a name or figures, and counts them', async () => {
      off.exportBytes = packedExport([
        row(POLISH, 'en:poland'),
        row('5900512320358', 'en:poland'),
        row('123456789012345678', 'en:poland'),
        { ...row(GERMAN, 'en:germany'), product_name: '  ' },
        {
          ...row(BOTH, 'en:germany'),
          'energy-kcal_100g': '',
          proteins_100g: '',
          fat_100g: '',
          carbohydrates_100g: '',
        },
      ]);
      await products.run(NIGHT);
      expect(await t.prisma.product.count()).toBe(1);
      expect((await state()).leftOut).toEqual({ code: 2, name: 1, figures: 1 });
    });

    it('a row whatever its script and whatever signs it holds', async () => {
      off.exportBytes = packedExport([
        row(POLISH, 'en:poland', 'Молоко\u0000 Домик'),
        row(GERMAN, 'en:germany', '牛乳\u0001'),
        row(BOTH, 'en:germany', 'Γάλα 😀 "x"'),
      ]);
      await products.run(NIGHT);
      expect(await state()).toMatchObject({ status: 'done', added: 3 });
      expect((await held(POLISH))?.name).toBe('Молоко Домик');
      expect((await held(GERMAN))?.name).toBe('牛乳');
      expect((await held(BOTH))?.name).toBe('Γάλα 😀 "x"');
    });

    it('a row with another number of columns not at all', async () => {
      const text = exportText([row(POLISH, 'en:poland')]);
      off.exportBytes = gzipSync(`${text}${GERMAN}\ten:germany\n`);
      await products.run(NIGHT);
      expect(await t.prisma.product.count()).toBe(1);
    });

    it('a line too long to be a product not at all, and goes on after it', async () => {
      const long = `${'x'.repeat(5 * 1024 * 1024)}en:poland\n`;
      const text = exportText([row(POLISH, 'en:poland')]);
      const [head, first] = text.split('\n');
      off.exportBytes = gzipSync(`${head}\n${long}${first}\n`);
      await products.run(NIGHT);
      expect(await t.prisma.product.count()).toBe(1);
      expect(await state()).toMatchObject({ status: 'done' });
    });

    it('the one changed last, of two spellings of one code', async () => {
      off.exportBytes = packedExport([
        { ...row('036000291452', 'en:poland', 'Starszy'), last_modified_t: 1700000000 },
        { ...row('0036000291452', 'en:poland', 'Nowszy'), last_modified_t: 1787927571 },
        { ...row('36000291452', 'en:poland', 'Bez cyfry') },
      ]);
      await products.run(NIGHT);
      expect((await held('0036000291452'))?.name).toBe('Nowszy');
    });

    it('more batches than one', async () => {
      const code = (n: number): string => {
        const body = `59000${String(n).padStart(7, '0')}`;
        const sum = [...body]
          .reverse()
          .reduce((all, digit, place) => all + Number(digit) * (place % 2 === 0 ? 3 : 1), 0);
        return `${body}${(10 - (sum % 10)) % 10}`;
      };
      off.exportBytes = packedExport(
        Array.from({ length: 2500 }, (_, n) => row(code(n), 'en:poland')),
      );
      await products.run(NIGHT);
      expect(await t.prisma.product.count()).toBe(2500);
      expect((await state()).perCountry.poland).toBe(2500);
    });
  });

  describe('run again', () => {
    beforeEach(async () => {
      await products.run(NIGHT);
    });

    it('writes only what differs', async () => {
      const before = await t.prisma.product.findMany({ orderBy: { code: 'asc' } });
      off.exportBytes = packedExport([
        { ...row(POLISH, 'en:poland', 'Mleko Łaciate'), 'energy-kcal_100g': 61 },
        row(GERMAN, 'en:germany'),
        row(BOTH, 'en:poland,en:germany'),
      ]);
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));

      const after = await t.prisma.product.findMany({ orderBy: { code: 'asc' } });
      expect(await state()).toMatchObject({ added: 0, changed: 1, removed: 0 });
      expect(after.map((one) => one.id)).toEqual(before.map((one) => one.id));
      expect((await held(POLISH))?.calories).toBe(61);
      // What did not change was not written.
      const untouched = (rows: typeof before) => rows.find((one) => one.code === GERMAN)?.readAt;
      expect(untouched(after)).toEqual(untouched(before));
    });

    it('removes what the export no longer brings, and a diary keeps what it wrote', async () => {
      const user = await aUser(t);
      const profile = await aProfile(t, user);
      const product = (await held(POLISH))!;
      const entry = await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .set('X-Client-Date', TODAY)
        .send({
          profileId: profile.id,
          date: TODAY,
          mealType: 'snack',
          kind: 'product',
          productId: product.id,
          quantity: 200,
        })
        .expect(201);

      off.exportBytes = packedExport([row(GERMAN, 'en:germany'), row(BOTH, 'en:germany')]);
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));

      expect(await held(POLISH)).toBeNull();
      expect(await state()).toMatchObject({ removed: 1 });
      const day = await t
        .http()
        .get('/api/diary/day')
        .set(as(user))
        .query({ profileId: profile.id, date: TODAY })
        .expect(200);
      expect(day.body.entries[0]).toMatchObject({
        id: entry.body.id,
        productId: null,
        name: 'Mleko Łaciate, Marka',
        nutrition: { calories: 120 },
      });
    });

    it('keeps a product a lookup brought, and takes it over once the export brings it', async () => {
      const looked = await t.prisma.product.create({
        data: {
          code: FRENCH,
          name: 'Z pytania',
          searchText: 'z pytania',
          unit: 'g',
          origin: 'looked_up',
        },
      });
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));
      expect(await held(FRENCH)).toMatchObject({ id: looked.id, origin: 'looked_up' });

      off.exportBytes = packedExport([
        row(POLISH, 'en:poland', 'Mleko Łaciate'),
        row(GERMAN, 'en:germany'),
        row(BOTH, 'en:poland,en:germany'),
        row(FRENCH, 'en:poland', 'Z eksportu'),
      ]);
      await products.run(new Date(NIGHT.getTime() + 14 * 24 * HOUR));
      expect(await held(FRENCH)).toMatchObject({
        id: looked.id,
        origin: 'imported',
        name: 'Z eksportu',
      });
    });

    it('forgets that a code was unknown once the export brings it', async () => {
      await t.prisma.productCodeUnknown.create({ data: { code: FRENCH } });
      off.exportBytes = packedExport([
        row(POLISH, 'en:poland', 'Mleko Łaciate'),
        row(GERMAN, 'en:germany'),
        row(BOTH, 'en:poland,en:germany'),
        row(FRENCH, 'en:poland'),
      ]);
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));
      expect(await t.prisma.productCodeUnknown.count()).toBe(0);
    });
  });

  describe('where accounts wrote a product of their own', () => {
    /** A product an account wrote of `code`, with the account it belongs to. */
    const written = async (code: string) => {
      const user = await aUser(t);
      await aProfile(t, user);
      await t
        .http()
        .post('/api/products/own')
        .set(as(user))
        .send({
          code,
          name: 'Mój produkt',
          brand: null,
          pack: null,
          unit: 'g',
          packAmount: null,
          servingAmount: null,
          per100: {
            calories: 100,
            protein: null,
            fat: null,
            carbs: null,
            fiber: null,
            sugars: null,
            salt: null,
            saturatedFat: null,
          },
        })
        .expect(201);
      return user;
    };
    const copies = (user: { id: string }) =>
      t.prisma.ownProduct.findMany({ where: { userId: user.id } });
    const noticeOf = async (user: { id: string }) =>
      (
        await t.prisma.notification.findMany({
          where: { profile: { userId: user.id }, type: 'product_replaced' },
        })
      ).map((row) => row.payload);

    it('leaves what the instance accepted as it is, whatever the export says of its code', async () => {
      const author = await aUser(t);
      const accepted = await t.prisma.product.create({
        data: {
          code: POLISH,
          name: 'Przyjęty',
          searchText: 'przyjety',
          unit: 'g',
          origin: 'accepted',
          calories: 123,
          authorId: author.id,
          acceptedBy: 'Anna',
          acceptedAt: NIGHT,
        },
      });

      await products.run(NIGHT);

      expect((await state()).status).toBe('done');
      expect(await held(POLISH)).toMatchObject({
        id: accepted.id,
        origin: 'accepted',
        name: 'Przyjęty',
        calories: 123,
        authorId: author.id,
      });
    });

    it('keeps it through the run that follows, as it is no product of the export', async () => {
      await t.prisma.product.create({
        data: {
          code: '4006381333931',
          name: 'Przyjęty',
          searchText: 'przyjety',
          unit: 'g',
          origin: 'accepted',
        },
      });

      await products.run(NIGHT);
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));

      expect(await held('4006381333931')).toMatchObject({ origin: 'accepted' });
    });

    it('gives what a copy holds way to what the export brings of its code, and tells its author', async () => {
      const user = await written(POLISH);

      await products.run(NIGHT);

      expect(await held(POLISH)).toMatchObject({ origin: 'imported', name: 'Mleko Łaciate' });
      expect(await copies(user)).toEqual([]);
      expect(await noticeOf(user)).toEqual([
        { name: 'Mój produkt', reason: null, replacedBy: 'open_food_facts' },
      ]);
    });

    it('keeps of another country only a code somebody wrote, and the copy gives way to it', async () => {
      const user = await written(FRENCH);

      await products.run(NIGHT);

      expect(await held(FRENCH)).toMatchObject({ origin: 'looked_up' });
      expect(await copies(user)).toEqual([]);
      expect(await noticeOf(user)).toHaveLength(1);
    });

    it('leaves a copy alone where the export does not know its code', async () => {
      const user = await written('4006381333931');

      await products.run(NIGHT);

      expect(await held('4006381333931')).toBeNull();
      expect(await copies(user)).toHaveLength(1);
      expect(await noticeOf(user)).toEqual([]);
    });

    it('leaves a copy without a code alone', async () => {
      const user = await aUser(t);
      await t.prisma.ownProduct.create({
        data: {
          userId: user.id,
          name: 'Bez kodu',
          searchText: 'bez kodu',
          unit: 'g',
          calories: 90,
        },
      });

      await products.run(NIGHT);

      expect(await copies(user)).toHaveLength(1);
    });
  });

  describe('changes nothing, and says why,', () => {
    let before: { code: string; name: string }[];

    beforeEach(async () => {
      await products.run(NIGHT);
      before = await t.prisma.product.findMany({
        orderBy: { code: 'asc' },
        select: { code: true, name: true },
      });
    });

    const stays = async () =>
      expect(
        await t.prisma.product.findMany({
          orderBy: { code: 'asc' },
          select: { code: true, name: true },
        }),
      ).toEqual(before);

    it('where the file ends before its packing says', async () => {
      const whole = packedExport([row(FRENCH, 'en:poland', 'Z ucietego')]);
      off.exportBytes = whole.subarray(0, whole.length - 12);
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));
      expect(await state()).toMatchObject({ status: 'error', reason: 'source' });
      await stays();
    });

    it('where the file is no packed text at all', async () => {
      off.exportBytes = Buffer.from('<html>Not here</html>');
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));
      expect(await state()).toMatchObject({ status: 'error', reason: 'source' });
      await stays();
    });

    it('where a column it reads is gone', async () => {
      off.exportBytes = packedExport(
        [row(POLISH, 'en:poland')],
        EXPORT_COLUMNS.filter((column) => column !== 'proteins_100g'),
      );
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));
      expect(await state()).toMatchObject({ status: 'error', reason: 'format' });
      expect((await state()).error).toContain('proteins_100g');
      await stays();
    });

    it('where the file is empty', async () => {
      off.exportBytes = gzipSync('');
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));
      expect(await state()).toMatchObject({ status: 'error', reason: 'format' });
      await stays();
    });

    it('where not one product of the countries named is there', async () => {
      off.exportBytes = packedExport([row(FRENCH, 'en:france')]);
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));
      expect(await state()).toMatchObject({ status: 'error', reason: 'nothing' });
      await stays();
    });

    it('where the export brings less than half of what the last one did', async () => {
      off.exportBytes = packedExport([row(GERMAN, 'en:germany')]);
      await products.run(new Date(NIGHT.getTime() + 7 * 24 * HOUR));
      expect(await state()).toMatchObject({ status: 'error', reason: 'shrunk' });
      await stays();
    });
  });

  describe('is due', () => {
    it('at night where it has never run', async () => {
      expect(await products.due(NIGHT)).toBe(true);
    });

    it('not by day, however long ago it ran', async () => {
      expect(await products.due(new Date(2026, 10, 2, 12, 0, 0))).toBe(false);
      expect(await products.due(new Date(2026, 10, 2, 1, 59, 0))).toBe(false);
      expect(await products.due(new Date(2026, 10, 2, 5, 0, 0))).toBe(false);
    });

    it('in the same night of the next week, and not before it', async () => {
      await products.run(NIGHT);
      expect(await products.due(new Date(NIGHT.getTime() + 24 * HOUR))).toBe(false);
      expect(await products.due(new Date(NIGHT.getTime() + 6 * 24 * HOUR))).toBe(false);
      expect(await products.due(new Date(NIGHT.getTime() + 7 * 24 * HOUR))).toBe(true);
    });

    it('the next night after a run that failed', async () => {
      off.exportBytes = Buffer.from('nothing packed');
      await products.run(NIGHT);
      expect(await products.due(new Date(NIGHT.getTime() + HOUR))).toBe(false);
      expect(await products.due(new Date(NIGHT.getTime() + 24 * HOUR))).toBe(true);
    });

    it('and runs once, where the worker looks every minute', async () => {
      await products.runIfDue(NIGHT);
      await products.runIfDue(new Date(NIGHT.getTime() + 60_000));
      expect(off.exportReads).toBe(1);
    });

    it('leaves a run that goes on alone', async () => {
      await Promise.all([products.run(NIGHT), products.run(NIGHT)]);
      expect(off.exportReads).toBe(1);
    });
  });

  describe('asked for in the panel', () => {
    const ask = () => t.http().post('/api/admin/products/import').set(asAdmin);
    /** What the panel's button is answered with; the route takes five a minute, so most tests ask the service. */
    const refusal = () =>
      products.ask().then(
        () => null,
        (err: { response: { error: string } }) => err.response.error,
      );
    const panel = async () =>
      (await t.http().get('/api/admin/products').set(asAdmin).expect(200)).body as AdminProducts;

    it('says where it stands, for the administrator alone', async () => {
      await products.run(NIGHT);
      await t.http().get('/api/admin/products').expect(401);
      const overview = await panel();
      expect(overview).toMatchObject({
        lookups: true,
        countries: ['poland', 'germany'],
        held: { imported: 3, lookedUp: 0, unknownCodes: 0 },
        askedAt: null,
      });
      expect(overview.import.perCountry).toEqual({ poland: 2, germany: 2 });
    });

    it('is begun by the worker by day, and once', async () => {
      await ask().expect(204);
      const midday = new Date(2026, 10, 2, 12, 0, 0);
      expect((await panel()).askedAt).not.toBeNull();

      await products.runIfDue(midday);
      expect(off.exportReads).toBe(1);
      expect((await panel()).askedAt).toBeNull();

      await products.runIfDue(new Date(midday.getTime() + 60_000));
      expect(off.exportReads).toBe(1);
    });

    it('is refused within a day of the last start, and says until when', async () => {
      await products.run(new Date());
      const refused = await ask().expect(409);
      expect(refused.body.error).toBe('PRODUCT_IMPORT_TOO_SOON');
      expect(new Date((await panel()).askAgainAt!).getTime()).toBeGreaterThan(
        Date.now() + 23 * HOUR,
      );
    });

    it('is taken at once after a run that failed before it read anything', async () => {
      off.exportBytes = Buffer.alloc(0);
      await products.run(new Date());
      expect(await state()).toMatchObject({ status: 'error', read: 0 });
      expect(await refusal()).toBeNull();
    });

    it('is refused after a run that failed once it had read the export', async () => {
      off.exportBytes = packedExport([row(FRENCH, 'en:france')]);
      await products.run(new Date());
      expect(await state()).toMatchObject({ status: 'error', reason: 'nothing', read: 1 });
      expect(await refusal()).toBe('PRODUCT_IMPORT_TOO_SOON');
    });

    it('is taken a day after the last start', async () => {
      await products.run(new Date(Date.now() - 25 * HOUR));
      expect(await refusal()).toBeNull();
    });

    it('is taken at once where the last run read other countries', async () => {
      await products.run(new Date());
      const row = await t.prisma.jobState.findUniqueOrThrow({ where: { name: 'product import' } });
      await t.prisma.jobState.update({
        where: { name: 'product import' },
        data: { state: { ...(row.state as object), countries: ['poland'] } },
      });
      expect(await refusal()).toBeNull();
    });

    it('is refused while a run goes on', async () => {
      await t.prisma.jobState.create({
        data: {
          name: 'product import',
          state: { status: 'running', startedAt: new Date().toISOString(), countries: [] },
          heartbeatAt: new Date(),
        },
      });
      expect(await refusal()).toBe('PRODUCT_IMPORT_RUNNING');
    });
  });

  it('removes what no longer counts of the lookups', async () => {
    const user = await aUser(t);
    const now = new Date();
    await t.prisma.productLookup.createMany({
      data: [
        { userId: user.id, at: new Date(now.getTime() - 25 * HOUR) },
        { userId: user.id, at: new Date(now.getTime() - HOUR) },
      ],
    });
    await t.prisma.productCodeUnknown.createMany({
      data: [
        { code: POLISH, askedAt: new Date(now.getTime() - 8 * 24 * HOUR) },
        { code: GERMAN, askedAt: new Date(now.getTime() - HOUR) },
      ],
    });
    expect(await products.prune(now)).toBe(2);
    expect(await t.prisma.productLookup.count()).toBe(1);
    expect(await t.prisma.productCodeUnknown.findMany()).toMatchObject([{ code: GERMAN }]);
  });

  it('removes a product no import brings once nobody asked for it in a long while, and a diary keeps what it wrote', async () => {
    const now = new Date();
    const user = await aUser(t);
    const profile = await aProfile(t, user);
    const aProduct = (code: string, origin: 'imported' | 'looked_up', daysAgo: number) =>
      t.prisma.product.create({
        data: {
          code,
          origin,
          name: `Produkt ${code}`,
          searchText: `produkt ${code}`,
          unit: 'g',
          calories: 100,
          protein: 1,
          fat: 1,
          carbs: 1,
          readAt: new Date(now.getTime() - daysAgo * 24 * HOUR),
        },
      });
    const old = await aProduct(POLISH, 'looked_up', 91);
    await aProduct(GERMAN, 'looked_up', 89);
    await aProduct(BOTH, 'imported', 400);
    await t
      .http()
      .post('/api/diary/entries')
      .set(as(user))
      .set('X-Client-Date', TODAY)
      .send({
        profileId: profile.id,
        date: TODAY,
        mealType: 'snack',
        kind: 'product',
        productId: old.id,
        quantity: 100,
      })
      .expect(201);

    expect(await products.prune(now)).toBe(1);

    expect(
      (await t.prisma.product.findMany({ orderBy: { code: 'asc' } })).map((one) => one.code),
    ).toEqual([GERMAN, BOTH].sort());
    expect(await t.prisma.diaryEntry.findFirstOrThrow()).toMatchObject({
      productId: null,
      name: `Produkt ${POLISH}`,
      calories: 100,
    });
  });
});
