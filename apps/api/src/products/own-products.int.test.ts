// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWN_PRODUCTS,
  type DiaryEntry,
  type OwnProduct,
  type OwnProductBody,
  type Product,
  type ProductAdditions,
  type ProductNoticePayload,
  type ProductQueue,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aReviewer, as, asAdmin, aUser, type TestUser } from '../testing/factories.js';
import { startFakeOpenFoodFacts, type FakeOpenFoodFacts } from '../testing/fake-open-food-facts.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ProductImport } from './product-import.js';

const JAM = '5900512320359';
const OTHER = '4001724819806';
const DAY = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);

const aBody = (over: Partial<OwnProductBody> = {}): OwnProductBody => ({
  code: JAM,
  name: 'Babcina konfitura',
  brand: 'Sklep na rogu',
  pack: '250 g',
  unit: 'g',
  packAmount: 250,
  servingAmount: 20,
  per100: {
    calories: 240,
    protein: 0.5,
    fat: 0.2,
    carbs: 58,
    fiber: 1,
    sugars: 55,
    salt: 0.01,
    saturatedFat: 0,
  },
  ...over,
});

describe('the products an account writes for itself', () => {
  let t: TestApp;
  let off: FakeOpenFoodFacts;
  let user: TestUser;
  let files: string;

  const write = (body: unknown, who: TestUser = user) =>
    t
      .http()
      .post('/api/products/own')
      .set(as(who))
      .send(body as object);
  const written = async (body: OwnProductBody = aBody(), who: TestUser = user) =>
    (await write(body, who).expect(201)).body as OwnProduct;
  const send = (id: string, who: TestUser = user) =>
    t.http().post(`/api/products/own/${id}/send`).set(as(who));
  const sent = async (body: OwnProductBody = aBody(), who: TestUser = user) =>
    (await send((await written(body, who)).id, who).expect(200)).body as OwnProduct;
  const noticesOf = async (who: TestUser) =>
    (
      await t.prisma.notification.findMany({
        where: { profile: { userId: who.id } },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => ({ type: row.type, payload: row.payload as ProductNoticePayload }));
  const accept = async (product: { id: string; updatedAt: string }) =>
    t
      .http()
      .post(`/api/admin/products/queue/${product.id}/accept`)
      .set(asAdmin)
      .send({ updatedAt: product.updatedAt });

  beforeAll(async () => {
    files = mkdtempSync(join(tmpdir(), 'own-products-'));
    off = await startFakeOpenFoodFacts();
    t = await createTestApp({
      OPEN_FOOD_FACTS_URL: off.url,
      OPEN_FOOD_FACTS_EXPORT_URL: off.exportUrl,
      OPERATOR_CONTACT: 'operator@example.org',
      INSTANCE_DATA_DIR: files,
    });
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
    await off.close();
    rmSync(files, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await t.prisma.product.deleteMany();
    await t.prisma.productCodeUnknown.deleteMany();
    await resetUserData(t.prisma);
    off.answers.clear();
    off.asked.length = 0;
    user = await aUser(t);
    await aProfile(t, user);
  });

  describe('written', () => {
    it('is kept with what was written, and is its author alone to read', async () => {
      const product = await written();

      expect(product).toMatchObject({
        code: JAM,
        source: 'own',
        name: 'Babcina konfitura',
        state: 'own',
        reason: null,
        doubtful: false,
      });
      const other = await aUser(t);
      const list = await t.http().get('/api/products/own').set(as(user)).expect(200);
      expect(list.body.items.map((item: OwnProduct) => item.id)).toEqual([product.id]);
      expect(
        (await t.http().get('/api/products/own').set(as(other)).expect(200)).body.items,
      ).toEqual([]);
      await t
        .http()
        .patch(`/api/products/own/${product.id}`)
        .set(as(other))
        .send(aBody())
        .expect(404);
      await t.http().delete(`/api/products/own/${product.id}`).set(as(other)).expect(404);
    });

    it('takes a code however it was read, and needs no more than a name and the energy', async () => {
      const product = await written(
        aBody({
          code: '590-0512-320359',
          brand: null,
          pack: null,
          packAmount: null,
          servingAmount: null,
          per100: {
            calories: 240,
            protein: null,
            fat: null,
            carbs: null,
            fiber: null,
            sugars: null,
            salt: null,
            saturatedFat: null,
          },
        }),
      );

      expect(product.code).toBe(JAM);
      expect(product.per100.protein).toBeNull();
    });

    it.each([
      ['energy over what anything holds', { per100: { ...aBody().per100, calories: 901 } }],
      ['a macronutrient over 100 g', { per100: { ...aBody().per100, protein: 101, carbs: 0 } }],
      [
        'macronutrients over 105 g together',
        { per100: { ...aBody().per100, protein: 50, fat: 10, carbs: 50, sugars: 1 } },
      ],
      ['sugars above the carbohydrates', { per100: { ...aBody().per100, carbs: 10, sugars: 11 } }],
      ['saturated fat above the fat', { per100: { ...aBody().per100, fat: 1, saturatedFat: 2 } }],
      ['a code that does not close', { code: '5900512320350' }],
      ['a name without a letter', { name: '...' }],
    ])('refuses %s', async (_what, over) => {
      await write(aBody(over as Partial<OwnProductBody>)).expect(400);
    });

    it('reads what is left out as not known, as a phone leaves it out', async () => {
      const answer = await write({
        name: 'Chleb',
        unit: 'g',
        per100: { calories: 240 },
      }).expect(201);

      expect(answer.body).toMatchObject({
        code: null,
        brand: null,
        pack: null,
        packAmount: null,
        servingAmount: null,
        per100: { calories: 240, protein: null, salt: null },
      });
    });

    it('marks figures that merely do not add up, for whoever reviews them', async () => {
      const product = await written(
        aBody({
          per100: { ...aBody().per100, calories: 700, protein: 1, fat: 1, carbs: 10, sugars: 5 },
        }),
      );

      expect(product.doubtful).toBe(true);
    });

    it('takes a code once on one account, and on another account as well', async () => {
      await written();

      const twice = await write(aBody({ name: 'Inna' })).expect(409);
      expect(twice.body.error).toBe('PRODUCT_CODE_HELD');
      await written(aBody(), await aUser(t));
    });

    it('refuses a code the base knows with figures, naming what to do', async () => {
      off.answers.set(JAM, {
        code: JAM,
        product_name: 'Konfitura ze sklepu',
        nutriments: {
          'energy-kcal_100g': 250,
          proteins_100g: 1,
          fat_100g: 1,
          carbohydrates_100g: 60,
        },
      });

      const refused = await write(aBody()).expect(409);

      expect(refused.body.error).toBe('PRODUCT_CODE_KNOWN');
      expect(off.asked.map((one) => one.code)).toEqual([JAM]);
      // Without a code it is the account's own business.
      await written(aBody({ code: null }));
    });

    it('takes a code the base holds without figures', async () => {
      off.answers.set(JAM, { code: JAM, product_name: 'Konfitura bez liczb', nutriments: {} });

      await written();
    });

    it('is written although Open Food Facts cannot be asked', async () => {
      off.answers.set(JAM, 503);

      await written();
    });

    it('holds an account to what it may hold and write', async () => {
      await t.prisma.ownProductChange.createMany({
        data: Array.from({ length: OWN_PRODUCTS.writtenADay }, () => ({
          userId: user.id,
          kind: 'written' as const,
        })),
      });

      const refused = await write(aBody({ code: null })).expect(429);
      expect(refused.body.error).toBe('OWN_PRODUCT_DAILY_LIMIT');

      await t.prisma.ownProductChange.updateMany({ data: { at: new Date(Date.now() - 2 * DAY) } });
      await t.prisma.ownProduct.createMany({
        data: Array.from({ length: OWN_PRODUCTS.held }, (_, n) => ({
          userId: user.id,
          name: `Produkt ${n}`,
          searchText: `produkt ${n}`,
          unit: 'g' as const,
          calories: 100,
        })),
      });
      const many = await write(aBody({ code: null })).expect(409);
      expect(many.body.error).toBe('OWN_PRODUCT_LIMIT');
    });

    it('counts what was written and deleted again', async () => {
      const product = await written(aBody({ code: null }));
      await t.http().delete(`/api/products/own/${product.id}`).set(as(user)).expect(204);

      expect(await t.prisma.ownProductChange.count({ where: { userId: user.id } })).toBe(1);
    });
  });

  describe('in a search and by its code', () => {
    it('comes first for its author, and for nobody else', async () => {
      await t.prisma.product.create({
        data: {
          code: OTHER,
          name: 'Konfitura truskawkowa',
          searchText: 'konfitura truskawkowa',
          unit: 'g',
          calories: 250,
          origin: 'imported',
          popularity: 1000,
        },
      });
      await written(aBody({ name: 'Moja konfitura', code: null }));

      const mine = (await t.http().get('/api/products?search=konfitura').set(as(user)).expect(200))
        .body.items as Product[];
      expect(mine.map((item) => [item.name, item.source])).toEqual([
        ['Moja konfitura', 'own'],
        ['Konfitura truskawkowa', 'open_food_facts'],
      ]);
      const theirs = await aUser(t);
      const found = (
        await t.http().get('/api/products?search=konfitura').set(as(theirs)).expect(200)
      ).body.items as Product[];
      expect(found.map((item) => item.name)).toEqual(['Konfitura truskawkowa']);
    });

    it('answers its code for its author, with nothing asked of anybody', async () => {
      await written();
      off.asked.length = 0;

      const answer = await t.http().get(`/api/products/code/${JAM}`).set(as(user)).expect(200);

      expect(answer.body.source).toBe('own');
      expect(off.asked).toEqual([]);
    });
  });

  describe('in the diary', () => {
    const entry = async (productId: string, who: TestUser = user) => {
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: who.id } });
      return t.http().post('/api/diary/entries').set(as(who)).send({
        profileId: profile.id,
        date: TODAY,
        mealType: 'snack',
        kind: 'product',
        productId,
        quantity: 50,
      });
    };

    it('is written as any product is, and keeps its figures when it goes', async () => {
      const product = await written();

      const added = (await entry(product.id)).body as DiaryEntry;
      expect(added).toMatchObject({ kind: 'product', productId: product.id, productSource: 'own' });
      expect(added.nutrition.calories).toBe(120);

      await t.http().delete(`/api/products/own/${product.id}`).set(as(user)).expect(204);
      const kept = await t.prisma.diaryEntry.findUniqueOrThrow({ where: { id: added.id } });
      expect(kept.ownProductId).toBeNull();
      expect(kept.calories).toBe(120);
    });

    it('says on the day it is copied to where its figures came from', async () => {
      const product = await written();
      await entry(product.id);
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
      const before = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

      const copied = await t
        .http()
        .post('/api/diary/copy')
        .set(as(user))
        .set('X-Client-Date', TODAY)
        .send({ profileId: profile.id, from: TODAY, to: before })
        .expect(201);

      expect(copied.body.day.entries).toEqual([
        expect.objectContaining({ kind: 'product', productSource: 'own' }),
      ]);
    });

    it('is estimated where its figures were left out', async () => {
      const product = await written(
        aBody({
          code: null,
          per100: {
            calories: 240,
            protein: null,
            fat: null,
            carbs: null,
            fiber: null,
            sugars: null,
            salt: null,
            saturatedFat: null,
          },
        }),
      );

      const added = (await entry(product.id)).body as DiaryEntry;

      expect(added.estimated).toBe(true);
      expect(added.nutrition.protein).toBeGreaterThan(0);
    });

    it("cannot be another account's", async () => {
      const product = await written();
      const other = await aUser(t);
      await aProfile(t, other);

      expect((await entry(product.id, other)).status).toBe(404);
    });
  });

  describe('sent to the base', () => {
    it('waits for a reviewer without its author being named', async () => {
      const product = await sent();

      expect(product).toMatchObject({ state: 'sent', reason: null });
      expect(product.sentAt).not.toBeNull();
      const queue = (await t.http().get('/api/admin/products/queue').set(asAdmin).expect(200))
        .body as ProductQueue;
      expect(queue.total).toBe(1);
      expect(queue.items[0]).toMatchObject({ id: product.id, code: JAM });
      expect(JSON.stringify(queue)).not.toContain(user.id);
      expect(queue.items[0]).not.toHaveProperty('userId');
    });

    it('needs a code and all four figures', async () => {
      const noCode = await written(aBody({ code: null }));
      const refused = await send(noCode.id).expect(409);
      expect(refused.body.error).toBe('OWN_PRODUCT_NOT_SENDABLE');

      const noFat = await written(
        aBody({ code: OTHER, per100: { ...aBody().per100, fat: null, saturatedFat: null } }),
      );
      await send(noFat.id).expect(409);
    });

    it('is held to ten in a day', async () => {
      await t.prisma.ownProductChange.createMany({
        data: Array.from({ length: OWN_PRODUCTS.sentADay }, () => ({
          userId: user.id,
          kind: 'sent' as const,
        })),
      });

      const refused = await send((await written()).id).expect(429);

      expect(refused.body.error).toBe('OWN_PRODUCT_SEND_LIMIT');
    });

    it('leaves the queue when it is changed, and has to be sent again', async () => {
      const product = await sent();

      const changed = await t
        .http()
        .patch(`/api/products/own/${product.id}`)
        .set(as(user))
        .send(aBody({ name: 'Konfitura poprawiona' }))
        .expect(200);

      expect(changed.body).toMatchObject({ state: 'own', sentAt: null });
      expect((await t.http().get('/api/admin/products/queue').set(asAdmin)).body.total).toBe(0);
    });

    it('is taken back by its author', async () => {
      const product = await sent();

      const back = await t
        .http()
        .post(`/api/products/own/${product.id}/withdraw`)
        .set(as(user))
        .expect(200);

      expect(back.body.state).toBe('own');
      await t.http().post(`/api/products/own/${product.id}/withdraw`).set(as(user)).expect(409);
    });
  });

  describe('accepted', () => {
    it("becomes everybody's, the diary's entries go with it, and its author is told", async () => {
      const product = await sent();
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
      const added = await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .send({
          profileId: profile.id,
          date: TODAY,
          mealType: 'snack',
          kind: 'product',
          productId: product.id,
          quantity: 50,
        })
        .expect(201);

      await (
        await accept(product)
      ).status;

      const answer = await t
        .http()
        .get(`/api/products/code/${JAM}`)
        .set(as(await aUser(t)))
        .expect(200);
      expect(answer.body).toMatchObject({ source: 'instance', name: 'Babcina konfitura' });
      expect(await t.prisma.ownProduct.count({ where: { id: product.id } })).toBe(0);
      const kept = await t.prisma.diaryEntry.findUniqueOrThrow({ where: { id: added.body.id } });
      expect(kept.productId).toBe(answer.body.id);
      expect(kept.calories).toBe(120);
      // What was written from its own figures still says so; an entry written from now on names the instance.
      expect(kept.productSource).toBe('own');
      const reader = await aUser(t);
      const theirs = await aProfile(t, reader);
      const later = await t
        .http()
        .post('/api/diary/entries')
        .set(as(reader))
        .send({
          profileId: theirs.id,
          date: TODAY,
          mealType: 'snack',
          kind: 'product',
          productId: answer.body.id,
          quantity: 50,
        })
        .expect(201);
      expect(later.body.productSource).toBe('instance');
      expect(await noticesOf(user)).toEqual([
        {
          type: 'product_accepted',
          payload: { name: 'Babcina konfitura', reason: null, replacedBy: null },
        },
      ]);
    });

    it('is refused where it changed since the reviewer read it', async () => {
      const product = await sent();

      const stale = await accept({ id: product.id, updatedAt: new Date(0).toISOString() });

      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('PRODUCT_CHANGED');
    });

    it('is refused where it is no longer waiting', async () => {
      const product = await written();

      const answer = await accept(product);

      expect(answer.status).toBe(409);
      expect(answer.body.error).toBe('PRODUCT_NOT_WAITING');
    });

    it('takes the place of what other accounts wrote of the code, and tells them', async () => {
      const product = await sent();
      const other = await aUser(t);
      await aProfile(t, other);
      await written(aBody({ name: 'Inna konfitura' }), other);

      expect((await accept(product)).status).toBe(204);

      expect(await t.prisma.ownProduct.count({ where: { userId: other.id } })).toBe(0);
      expect(await noticesOf(other)).toEqual([
        {
          type: 'product_replaced',
          payload: { name: 'Inna konfitura', reason: null, replacedBy: 'instance' },
        },
      ]);
    });

    it('is taken by a reviewer under the name they review by', async () => {
      const product = await sent();
      const session = await aReviewer(t);

      await t
        .http()
        .post(`/api/review/products/${product.id}/accept`)
        .set(session)
        .send({ updatedAt: product.updatedAt })
        .expect(204);

      const row = await t.prisma.product.findUniqueOrThrow({ where: { code: JAM } });
      expect(row).toMatchObject({
        origin: 'accepted',
        acceptedBy: 'pl reviewer',
        authorId: user.id,
      });
    });

    it("goes into the instance's files and the file anybody signed in can read, without its author", async () => {
      expect((await accept(await sent())).status).toBe(204);

      const onDisk = JSON.parse(
        readFileSync(join(files, 'products.json'), 'utf8'),
      ) as ProductAdditions;
      expect(onDisk.products.map((one) => one.code)).toEqual([JAM]);
      expect(JSON.parse(readFileSync(join(files, 'manifest.json'), 'utf8')).products).toBe(1);
      const file = await t
        .http()
        .get('/api/products/additions')
        .set(as(await aUser(t)))
        .expect(200);
      expect(file.headers['content-disposition']).toContain('attachment');
      expect(file.body.license).toBe('ODbL-1.0');
      expect(file.body.products[0].code).toBe(JAM);
      expect(JSON.stringify(file.body)).not.toContain(user.id);
    });

    it('stays in the base when its author deletes their account', async () => {
      expect((await accept(await sent())).status).toBe(204);

      await t.prisma.user.delete({ where: { id: user.id } });

      const row = await t.prisma.product.findUniqueOrThrow({ where: { code: JAM } });
      expect(row.authorId).toBeNull();
    });
  });

  describe('turned down', () => {
    it("stays its author's, who is told why", async () => {
      const product = await sent();

      await t
        .http()
        .post(`/api/admin/products/queue/${product.id}/reject`)
        .set(asAdmin)
        .send({ updatedAt: product.updatedAt, reason: 'Zdjęcie etykiety mówi co innego.' })
        .expect(204);

      const [mine] = (await t.http().get('/api/products/own').set(as(user))).body
        .items as OwnProduct[];
      expect(mine).toMatchObject({ state: 'rejected', reason: 'Zdjęcie etykiety mówi co innego.' });
      expect(await noticesOf(user)).toEqual([
        {
          type: 'product_rejected',
          payload: {
            name: 'Babcina konfitura',
            reason: 'Zdjęcie etykiety mówi co innego.',
            replacedBy: null,
          },
        },
      ]);
    });

    it('goes back to being its own when it is changed, without the reason', async () => {
      const product = await sent();
      await t
        .http()
        .post(`/api/admin/products/queue/${product.id}/reject`)
        .set(asAdmin)
        .send({ updatedAt: product.updatedAt, reason: 'Nie.' })
        .expect(204);

      const changed = await t
        .http()
        .patch(`/api/products/own/${product.id}`)
        .set(as(user))
        .send(aBody())
        .expect(200);

      expect(changed.body).toMatchObject({ state: 'own', reason: null });
    });
  });

  describe('withdrawn by the administrator', () => {
    const withdraw = (id: string, reason = 'Błędne dane.') =>
      t.http().post(`/api/admin/products/accepted/${id}/withdraw`).set(asAdmin).send({ reason });

    it('goes back to its author as turned down, with its entries', async () => {
      expect((await accept(await sent())).status).toBe(204);
      const row = await t.prisma.product.findUniqueOrThrow({ where: { code: JAM } });
      const listed = await t.http().get('/api/admin/products/accepted').set(asAdmin).expect(200);
      expect(listed.body.items[0]).toMatchObject({ id: row.id, hasAuthor: true });
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
      const added = await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .send({
          profileId: profile.id,
          date: TODAY,
          mealType: 'snack',
          kind: 'product',
          productId: row.id,
          quantity: 50,
        })
        .expect(201);

      await withdraw(row.id).expect(204);

      expect(await t.prisma.product.count({ where: { code: JAM } })).toBe(0);
      const [mine] = (await t.http().get('/api/products/own').set(as(user))).body
        .items as OwnProduct[];
      expect(mine).toMatchObject({ code: JAM, state: 'rejected', reason: 'Błędne dane.' });
      const kept = await t.prisma.diaryEntry.findUniqueOrThrow({ where: { id: added.body.id } });
      expect(kept.ownProductId).toBe(mine!.id);
      expect((await noticesOf(user)).at(-1)).toEqual({
        type: 'product_withdrawn',
        payload: { name: 'Babcina konfitura', reason: 'Błędne dane.', replacedBy: null },
      });
    });

    it('is removed where its author is gone, and diaries keep their figures', async () => {
      expect((await accept(await sent())).status).toBe(204);
      const row = await t.prisma.product.findUniqueOrThrow({ where: { code: JAM } });
      await t.prisma.user.delete({ where: { id: user.id } });

      await withdraw(row.id).expect(204);

      expect(await t.prisma.product.count({ where: { code: JAM } })).toBe(0);
      expect(await t.prisma.ownProduct.count({ where: { code: JAM } })).toBe(0);
    });

    it('is only what was accepted', async () => {
      const imported = await t.prisma.product.create({
        data: {
          code: OTHER,
          name: 'Z importu',
          searchText: 'z importu',
          unit: 'g',
          calories: 100,
          origin: 'imported',
        },
      });

      await withdraw(imported.id).expect(404);
    });
  });

  describe('when the base gets its code from Open Food Facts', () => {
    const SAID = {
      code: JAM,
      product_name: 'Konfitura ze sklepu',
      nutriments: {
        'energy-kcal_100g': 250,
        proteins_100g: 1,
        fat_100g: 1,
        carbohydrates_100g: 60,
      },
    };

    it('gives way when somebody else looks the code up, and its author is told', async () => {
      await written();
      off.answers.set(JAM, SAID);
      // What it was asked when the product was written is forgotten after some days.
      await t.prisma.productCodeUnknown.deleteMany();
      const other = await aUser(t);

      const answer = await t.http().get(`/api/products/code/${JAM}`).set(as(other)).expect(200);

      expect(answer.body.source).toBe('open_food_facts');
      expect(await t.prisma.ownProduct.count({ where: { code: JAM } })).toBe(0);
      expect(await noticesOf(user)).toEqual([
        {
          type: 'product_replaced',
          payload: {
            name: 'Babcina konfitura',
            reason: null,
            replacedBy: 'open_food_facts',
          },
        },
      ]);
    });

    it('is asked about by the worker a few at a time, each at most once a week', async () => {
      await written();
      await written(aBody({ code: OTHER, name: 'Druga' }));
      off.asked.length = 0;
      const imports = t.app.get(ProductImport);
      const now = new Date();

      await imports.checkWrittenCodes(now);
      expect(off.asked).toHaveLength(2);

      off.asked.length = 0;
      await imports.checkWrittenCodes(new Date(now.getTime() + DAY));
      expect(off.asked).toEqual([]);

      off.answers.set(JAM, SAID);
      await imports.checkWrittenCodes(new Date(now.getTime() + 8 * DAY));
      expect(off.asked).toHaveLength(2);
      expect(await t.prisma.ownProduct.count({ where: { code: JAM } })).toBe(0);
      expect(await t.prisma.ownProduct.count({ where: { code: OTHER } })).toBe(1);
    });
  });

  describe('an account deleted', () => {
    it('takes what was its own with it', async () => {
      await sent();

      await t.prisma.user.delete({ where: { id: user.id } });

      expect(await t.prisma.ownProduct.count()).toBe(0);
    });
  });
});
