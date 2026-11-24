// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { randomUUID } from 'node:crypto';
import { dayAfter, MAX_QUANTITY, type InventoryItem, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
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

  const ingredientId = async (slug: string): Promise<string> =>
    (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;

  /** Add `quantity` of an ingredient to the pantry of `profile` as `user`. */
  const add = async (
    slug: string,
    quantity: number,
    unit: string,
    more: Record<string, unknown> = {},
  ) =>
    t
      .http()
      .post('/api/inventory')
      .set(as(user))
      .send({
        profileId: profile.id,
        ingredientId: await ingredientId(slug),
        quantity,
        unit,
        ...more,
      });

  /** The profile's pantry as the API lists it: each row's quantity, fresh or frozen, and its day, in a fixed order. */
  const shown = async (): Promise<string[]> =>
    (
      (await t.http().get(`/api/inventory?profileId=${profile.id}`).set(as(user)).expect(200))
        .body as InventoryItem[]
    )
      .map((row) => `${row.quantity} ${row.frozen ? 'frozen' : 'fresh'} ${row.bestBefore}`)
      .sort();

  it('stores a row for a catalogue ingredient and adds to it on a second post', async () => {
    await add('rolled-oats', 300, 'g');
    const second = await add('rolled-oats', 300, 'g');

    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ quantity: 600, unit: 'g' });
    expect(await t.prisma.inventoryItem.count({ where: { profileId: profile.id } })).toBe(1);
  });

  it('keeps one ingredient in more than one unit, a row for each', async () => {
    // Bananas are weighed, and a banana has a weight.
    await add('banana', 3, 'piece');
    await add('banana', 200, 'g');

    const rows = await t
      .http()
      .get(`/api/inventory?profileId=${profile.id}`)
      .set(as(user))
      .expect(200);

    expect(
      rows.body
        .map((row: { quantity: number; unit: string }) => `${row.quantity} ${row.unit}`)
        .sort(),
    ).toEqual(['200 g', '3 piece']);
  });

  it('puts what is frozen into packages of their own beside what is fresh, none adding to another', async () => {
    await add('chicken-breast', 500, 'g', { bestBefore: '2026-01-07' });
    await add('chicken-breast', 286, 'g', { frozen: true, bestBefore: '2026-02-04' });
    const again = await add('chicken-breast', 100, 'g', { frozen: true, bestBefore: '2026-02-10' });

    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({
      quantity: 100,
      unit: 'g',
      frozen: true,
      bestBefore: '2026-02-10',
    });
    expect(await shown()).toEqual([
      '100 frozen 2026-02-10',
      '286 frozen 2026-02-04',
      '500 fresh 2026-01-07',
    ]);
  });

  it('splits what goes into the freezer into the portions asked for, what is counted in whole pieces', async () => {
    const first = await add('chicken-breast', 1000, 'g', {
      frozen: true,
      portions: 4,
      bestBefore: '2026-02-04',
    });
    await add('large-egg', 6, 'piece', { frozen: true, portions: 4 });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ quantity: 250, frozen: true });
    expect(await shown()).toEqual([
      '1 frozen null',
      '1 frozen null',
      '2 frozen null',
      '2 frozen null',
      '250 frozen 2026-02-04',
      '250 frozen 2026-02-04',
      '250 frozen 2026-02-04',
      '250 frozen 2026-02-04',
    ]);
    // Each package has a number of its own, never one another has.
    const parcels = (
      await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id } })
    ).map((row) => row.parcel);
    expect(new Set(parcels).size).toBe(8);
  });

  it('refuses portions of less than one of their unit, and puts nothing in', async () => {
    const refused = await add('large-egg', 3, 'piece', { frozen: true, portions: 4 });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('PORTIONS_TOO_MANY');
    expect(await shown()).toEqual([]);
  });

  it('keeps what is counted in its pieces alone, turning an amount in grams into them', async () => {
    // An egg weighs 55 g: 110 g are two of them.
    await add('large-egg', 6, 'piece');
    const weighed = await add('large-egg', 110, 'g');
    const first = await add('wholegrain-bread', 70, 'g');

    expect(weighed.status).toBe(201);
    expect(weighed.body).toMatchObject({
      quantity: 8,
      unit: 'piece',
      display: { quantity: 8, unit: 'piece' },
    });
    expect(first.body).toMatchObject({
      quantity: 2,
      unit: 'piece',
      display: { quantity: 2, unit: 'slice' },
    });
    const rows = await t.prisma.inventoryItem.findMany({
      where: { profileId: profile.id },
      orderBy: { quantity: 'asc' },
    });
    expect(rows.map((row) => `${row.quantity} ${row.unit}`)).toEqual(['2 piece', '8 piece']);
  });

  it("lists the rows by aisle, then by name as the reader's language sorts names, then by unit", async () => {
    for (const [slug, quantity, unit] of [
      ['rolled-oats', 500, 'g'],
      ['large-egg', 6, 'piece'],
      ['greek-yogurt', 400, 'g'],
      ['wholegrain-bread', 4, 'piece'],
      ['banana', 2, 'piece'],
      ['banana', 200, 'g'],
      ['tomato', 300, 'g'],
      ['salmon', 250, 'g'],
    ] as const) {
      await add(slug, quantity, unit);
    }
    const listed = async (locale: string): Promise<string[]> =>
      (
        (
          await t
            .http()
            .get(`/api/inventory?profileId=${profile.id}`)
            .set(as(user))
            .set('Accept-Language', locale)
            .expect(200)
        ).body as InventoryItem[]
      ).map((row) => `${row.ingredient.name} ${row.unit}`);

    expect(await listed('pl')).toEqual([
      'Pomidor g',
      'Banan g',
      'Banan piece',
      'Łosoś g',
      'Jajko piece',
      'Jogurt grecki g',
      'Chleb pełnoziarnisty piece',
      'Płatki owsiane g',
    ]);
    expect(await listed('en')).toEqual([
      'Tomato g',
      'Banana g',
      'Banana piece',
      'Salmon g',
      'Greek yogurt g',
      'Large egg piece',
      'Rolled oats g',
      'Wholegrain bread piece',
    ]);
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

  it('refuses a new row of an ingredient the catalogue retired, as the diary and recipes do, and adds to one the pantry holds', async () => {
    const retire = (slug: string, retiredAt: Date | null) =>
      t.prisma.ingredient.update({ where: { slug }, data: { retiredAt } });
    await add('banana', 2, 'piece').then((res) => expect(res.status).toBe(201));
    await retire('banana', new Date());
    await retire('broccoli', new Date());
    try {
      const refused = await add('broccoli', 200, 'g');
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ error: 'INGREDIENT_NOT_FOUND' });
      expect(
        await t.prisma.inventoryItem.count({
          where: { profileId: profile.id, ingredientId: await ingredientId('broccoli') },
        }),
      ).toBe(0);
      // Food that is still in the kitchen: what is added goes beside it.
      const added = await add('banana', 1, 'piece');
      expect(added.status).toBe(201);
      expect(added.body).toMatchObject({ quantity: 3, unit: 'piece' });
    } finally {
      await retire('banana', null);
      await retire('broccoli', null);
    }
  });

  describe('what a row is shown as', () => {
    it('calls a piece what the ingredient calls it, and rounds what arithmetic left behind', async () => {
      const bread = await add('wholegrain-bread', 4, 'piece');
      const eggs = await add('large-egg', 6.5454, 'piece');
      const oats = await add('rolled-oats', 213.4, 'g');

      // With what they weigh, a piece taken at its average.
      expect(bread.body.display).toEqual({ quantity: 4, unit: 'slice', grams: 140 });
      expect(eggs.body.display).toEqual({ quantity: 6.5, unit: 'piece', grams: 360 });
      expect(oats.body.display).toEqual({ quantity: 213, unit: 'g' });
      // The exact number stays what the row holds.
      expect(oats.body.quantity).toBe(213.4);
      expect(bread.body.ingredient.displayUnit).toBe('slice');
    });

    it('gives the best-before date as a date, keeps it when a later post leaves it out and replaces it when one names another', async () => {
      const first = await add('whole-milk', 500, 'ml', { bestBefore: '2026-11-05' });
      const second = await add('whole-milk', 500, 'ml');
      const third = await add('whole-milk', 500, 'ml', { bestBefore: '2026-11-20' });

      expect(first.body).toMatchObject({ bestBefore: '2026-11-05' });
      expect(second.body).toMatchObject({ quantity: 1000, bestBefore: '2026-11-05' });
      expect(third.body).toMatchObject({ quantity: 1500, bestBefore: '2026-11-20' });
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
      expect(
        (await t.prisma.inventoryItem.findFirstOrThrow({ where: { profileId: profile.id } }))
          .quantity,
      ).toBe(MAX_QUANTITY.g);
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

      expect(
        results.map((result) => (result.status === 'fulfilled' ? result.value.status : 'threw')),
      ).toEqual([201, 201, 201, 201]);
      const rows = await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id } });
      expect(rows.map((row) => row.quantity)).toEqual([400]);
    });
  });

  describe('a row that is there', () => {
    it('can be set to another quantity, zero included, and to no more than the ceiling', async () => {
      const row = (await add('rolled-oats', 300, 'g')).body as { id: string };

      const set = await t
        .http()
        .patch(`/api/inventory/${row.id}`)
        .set(as(user))
        .send({ quantity: 125 })
        .expect(200);
      const emptied = await t
        .http()
        .patch(`/api/inventory/${row.id}`)
        .set(as(user))
        .send({ quantity: 0 })
        .expect(200);
      const tooMuch = await t
        .http()
        .patch(`/api/inventory/${row.id}`)
        .set(as(user))
        .send({ quantity: MAX_QUANTITY.g + 1 });

      expect(set.body.quantity).toBe(125);
      expect(emptied.body.quantity).toBe(0);
      expect(tooMuch.status).toBe(400);
    });

    it('keeps what a patch does not name', async () => {
      const row = (await add('whole-milk', 500, 'ml', { bestBefore: '2026-11-05' })).body as {
        id: string;
      };

      const halved = await t
        .http()
        .patch(`/api/inventory/${row.id}`)
        .set(as(user))
        .send({ quantity: 250 })
        .expect(200);
      const undated = await t
        .http()
        .patch(`/api/inventory/${row.id}`)
        .set(as(user))
        .send({ bestBefore: null })
        .expect(200);

      expect(halved.body).toMatchObject({ quantity: 250, bestBefore: '2026-11-05' });
      expect(undated.body).toMatchObject({ quantity: 250, bestBefore: null });
    });

    it('can be deleted, after which it is not found', async () => {
      const row = (await add('rolled-oats', 300, 'g')).body as { id: string };

      await t.http().delete(`/api/inventory/${row.id}`).set(as(user)).expect(204);

      const again = await t
        .http()
        .patch(`/api/inventory/${row.id}`)
        .set(as(user))
        .send({ quantity: 5 })
        .expect(404);
      expect(again.body.error).toBe('INVENTORY_ITEM_NOT_FOUND');
      await t.http().delete(`/api/inventory/${randomUUID()}`).set(as(user)).expect(404);
    });
  });

  describe('a row put in the freezer', () => {
    // The client's day is taken only where it is the server's or one beside it.
    const today = new Date().toISOString().slice(0, 10);
    const freeze = (
      id: string,
      body: object = {},
      more: { key?: string; day?: string | null } = {},
    ) => {
      const sent = t.http().post(`/api/inventory/${id}/freeze`).set(as(user));
      if (more.day !== null) sent.set('x-client-date', more.day ?? today);
      if (more.key) sent.set('Idempotency-Key', more.key);
      return sent.send(body);
    };
    const asText = (rows: InventoryItem[]) =>
      rows
        .map((row) => `${row.quantity} ${row.frozen ? 'frozen' : 'fresh'} ${row.bestBefore}`)
        .sort();

    it("goes in whole as a package of its own, dated 30 days from the client's day, answered with the pantry", async () => {
      await add('chicken-breast', 286, 'g', { frozen: true, bestBefore: dayAfter(today, 10) });
      const row = (await add('chicken-breast', 500, 'g', { bestBefore: dayAfter(today, 2) }))
        .body as { id: string };

      const frozen = await freeze(row.id).expect(200);

      expect(asText(frozen.body)).toEqual([
        `286 frozen ${dayAfter(today, 10)}`,
        `500 frozen ${dayAfter(today, 30)}`,
      ]);
      expect(await shown()).toEqual(asText(frozen.body));
    });

    it('is split into the portions asked for, as evenly as its unit allows', async () => {
      const chicken = (await add('chicken-breast', 1000, 'g')).body as { id: string };
      const eggs = (await add('large-egg', 6, 'piece')).body as { id: string };

      await freeze(chicken.id, { portions: 4 }).expect(200);
      const after = await freeze(eggs.id, { portions: 4 }).expect(200);

      const thirty = dayAfter(today, 30);
      expect(asText(after.body)).toEqual([
        `1 frozen ${thirty}`,
        `1 frozen ${thirty}`,
        `2 frozen ${thirty}`,
        `2 frozen ${thirty}`,
        `250 frozen ${thirty}`,
        `250 frozen ${thirty}`,
        `250 frozen ${thirty}`,
        `250 frozen ${thirty}`,
      ]);
    });

    it('is split into whole grams, the larger portions first', async () => {
      const rice = (await add('white-rice', 500, 'g')).body as { id: string };

      const after = await freeze(rice.id, { portions: 3 }).expect(200);

      const thirty = dayAfter(today, 30);
      expect(asText(after.body)).toEqual([
        `166 frozen ${thirty}`,
        `167 frozen ${thirty}`,
        `167 frozen ${thirty}`,
      ]);
    });

    it('is refused where a portion would hold less than one of its unit, and nothing changes', async () => {
      const row = (await add('large-egg', 3, 'piece')).body as { id: string };

      const refused = await freeze(row.id, { portions: 4 }).expect(400);

      expect(refused.body.error).toBe('PORTIONS_TOO_MANY');
      expect(await shown()).toEqual(['3 fresh null']);
    });

    it('leaves a row already frozen as it is', async () => {
      const row = (
        await add('chicken-breast', 286, 'g', { frozen: true, bestBefore: dayAfter(today, 5) })
      ).body as { id: string; updatedAt: string };

      const again = await freeze(row.id).expect(200);

      expect(asText(again.body)).toEqual([`286 frozen ${dayAfter(today, 5)}`]);
      expect(
        (
          await t.prisma.inventoryItem.findUniqueOrThrow({ where: { id: row.id } })
        ).updatedAt.toISOString(),
      ).toBe(row.updatedAt);
    });

    it('is answered with the pantry as it is now when sent again with its key, and freezes nothing twice', async () => {
      const row = (await add('chicken-breast', 500, 'g')).body as { id: string };
      const key = randomUUID();

      await freeze(row.id, { portions: 2 }, { key }).expect(200);
      const again = await freeze(row.id, { portions: 2 }, { key }).expect(200);

      expect(asText(again.body)).toEqual([
        `250 frozen ${dayAfter(today, 30)}`,
        `250 frozen ${dayAfter(today, 30)}`,
      ]);
      // Without its key, the row it was is gone.
      expect((await freeze(row.id).expect(404)).body.error).toBe('INVENTORY_ITEM_NOT_FOUND');
    });

    it('takes no more rows than the pantry has room for', async () => {
      const row = (await add('rolled-oats', 300, 'g')).body as { id: string };
      const ingredient = await ingredientId('rolled-oats');
      // 998 more frozen packages: the pantry holds 999 of its 1000 rows.
      await t.prisma.inventoryItem.createMany({
        data: Array.from({ length: 998 }, (_, at) => ({
          profileId: profile.id,
          ingredientId: ingredient,
          quantity: 1,
          unit: 'g' as const,
          frozen: true,
          parcel: 10_000 + at,
        })),
      });

      const refused = await freeze(row.id, { portions: 3 }).expect(409);

      expect(refused.body.error).toBe('PANTRY_FULL');
      expect(
        (await t.prisma.inventoryItem.findUniqueOrThrow({ where: { id: row.id } })).frozen,
      ).toBe(false);
    });

    it("goes by the server's day where the client names none", async () => {
      const row = (await add('chicken-breast', 500, 'g')).body as { id: string };

      const frozen = await freeze(row.id, {}, { day: null }).expect(200);

      expect(asText(frozen.body)).toEqual([
        `500 frozen ${dayAfter(new Date().toISOString().slice(0, 10), 30)}`,
      ]);
    });
  });

  describe("another user's pantry", () => {
    it('cannot be read, added to, changed or emptied', async () => {
      const row = (await add('rolled-oats', 300, 'g')).body as { id: string };
      const other = await aUser(t);

      await t.http().get(`/api/inventory?profileId=${profile.id}`).set(as(other)).expect(404);
      await t
        .http()
        .post('/api/inventory')
        .set(as(other))
        .send({
          profileId: profile.id,
          ingredientId: await ingredientId('rolled-oats'),
          quantity: 1,
          unit: 'g',
        })
        .expect(404);
      await t
        .http()
        .patch(`/api/inventory/${row.id}`)
        .set(as(other))
        .send({ quantity: 1 })
        .expect(404);
      await t.http().delete(`/api/inventory/${row.id}`).set(as(other)).expect(404);
      await t.http().post(`/api/inventory/${row.id}/freeze`).set(as(other)).send({}).expect(404);

      expect(
        (await t.prisma.inventoryItem.findUniqueOrThrow({ where: { id: row.id } })).quantity,
      ).toBe(300);
    });
  });

  describe('the size to freeze a row in', () => {
    /** The server's day, the one a client may name or one next to it. */
    const today = new Date().toISOString().slice(0, 10);

    /** Plan days as the tests give them dishes: their meals, each with its time of day. */
    type Days = readonly { meals: readonly { id: string; mealType: string }[] }[];

    /** Every meal of `days` the dish `menu` names for its day and time of day, in its servings: tofu where it names none. */
    const serve = async (
      days: Days,
      menu: (day: number, mealType: string) => [slug: string, servings: number] | null,
    ) => {
      for (const [day, { meals }] of days.entries())
        for (const meal of meals) {
          const [slug, servings] = menu(day, meal.mealType) ?? ['tofu-rice-bowl', 1];
          const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug } });
          await t.prisma.plannedMeal.update({
            where: { id: meal.id },
            data: { recipeId: recipe.id, servings, quantityScale: 1 },
          });
        }
    };
    /** Chicken (150 g a serving) at lunch in the servings given each day, nothing of it where none is given. */
    const chickenLunches =
      (servings: readonly (number | null)[]) =>
      (day: number, mealType: string): [string, number] | null =>
        mealType === 'lunch' && servings[day] != null
          ? ['chicken-rice-broccoli', servings[day]!]
          : null;

    /** A plan from `start` whose lunch each day is chicken in the servings given, and whose every other meal is tofu. */
    const lunches = async (start: string, servings: (number | null)[]) => {
      const plan = await aPlan(t, user, profile, {
        startDate: start,
        durationDays: servings.length,
      });
      await serve(plan.days, chickenLunches(servings));
    };
    const portionOf = async (id: string, day: string) =>
      (
        await t
          .http()
          .get(`/api/inventory/${id}/portion`)
          .set(as(user))
          .set('X-Client-Date', day)
          .expect(200)
      ).body as { portion: number | null; unit: string };

    it("is the most the profile's plans eat of its food on a day and the next, from tomorrow on", async () => {
      // Yesterday's and today's lunches are tofu, tomorrow's one serving of chicken, the next day's two.
      await lunches(dayAfter(today, -1), [null, null, 1, 2]);
      const row = (await add('chicken-breast', 500, 'g')).body as InventoryItem;

      expect(await portionOf(row.id, today)).toEqual({ portion: 450, unit: 'g' });
      // For a client already in tomorrow its lunch is too late to take a package out for: the next day's 300 g are
      // the most.
      expect(await portionOf(row.id, dayAfter(today, 1))).toEqual({ portion: 300, unit: 'g' });
    });

    it('is none from a plan with no day after today, for a food not bought in packs, and of a row of another account', async () => {
      await lunches(dayAfter(today, -2), [1, 1, 1]);
      const chicken = (await add('chicken-breast', 500, 'g')).body as InventoryItem;
      expect(await portionOf(chicken.id, today)).toEqual({ portion: null, unit: 'g' });

      // Tofu is eaten every day from tomorrow, but not bought in packs.
      await lunches(dayAfter(today, 1), [1, 1, 1]);
      const tofu = (await add('firm-tofu', 400, 'g')).body as InventoryItem;
      expect(await portionOf(tofu.id, today)).toEqual({ portion: null, unit: 'g' });
      expect(await portionOf(chicken.id, today)).toEqual({ portion: 300, unit: 'g' });

      const someone = await aUser(t);
      await t.http().get(`/api/inventory/${tofu.id}/portion`).set(as(someone)).expect(404);
    });

    it('counts with a joint plan the other plan of its kitchen, which eats from the same freezer', async () => {
      const partner = await aProfile(t, user);
      const plan = await aPlan(t, user, profile, {
        startDate: dayAfter(today, -1),
        durationDays: 3,
        withProfileId: partner.id,
      });
      const { jointPlanId } = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      const theirs = await t.prisma.mealPlan.findFirstOrThrow({
        where: { jointPlanId, id: { not: plan.id } },
        select: {
          days: {
            orderBy: { date: 'asc' },
            select: { meals: { select: { id: true, mealType: true } } },
          },
        },
      });
      // This plan eats a serving of chicken tomorrow, the other plan two.
      await serve(plan.days, chickenLunches([null, null, 1]));
      await serve(theirs.days, chickenLunches([null, null, 2]));
      const row = (await add('chicken-breast', 500, 'g')).body as InventoryItem;

      expect(await portionOf(row.id, today)).toEqual({ portion: 450, unit: 'g' });
    });

    it('is in whole pieces, rounded down, for a row kept in pieces', async () => {
      const plan = await aPlan(t, user, profile, {
        startDate: dayAfter(today, -1),
        durationDays: 4,
      });
      // Bread, 35 g a slice: two toasts of two slices tomorrow, and a slice and a half the day after.
      await serve(plan.days, (day, mealType) =>
        mealType !== 'breakfast'
          ? null
          : day === 2
            ? ['peanut-butter-toast', 2]
            : day === 3
              ? ['tofu-scramble', 1.5]
              : null,
      );
      const slices = (await add('wholegrain-bread', 10, 'piece')).body as InventoryItem;

      expect(await portionOf(slices.id, today)).toEqual({ portion: 5, unit: 'piece' });
    });
  });
});
