// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { HouseholdList, MealPlan, Profile, ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { HouseholdListsService } from './household-lists.service.js';

/** The fixture recipes the menus below are made of, with what one serving takes. */
const PORRIDGE = 'milk-porridge'; // 60 g oats, 250 ml milk
const TOFU_BOWL = 'tofu-rice-bowl'; // 180 g tofu, 80 g rice, 100 g broccoli, 5 ml oil
const CHICKEN_RICE = 'chicken-rice-broccoli'; // 150 g chicken, 80 g rice, 150 g broccoli, 10 ml oil

/** Long before the plans below begin. */
const BEFORE = new Date('2025-12-01');

describe('a shopping list for a household', () => {
  let t: TestApp;
  let households: HouseholdListsService;
  let user: TestUser;
  let adam: Profile;
  let ewa: Profile;
  /** Adam's plan: seven days from Monday 5 January 2026. */
  let ofAdam: MealPlan;
  /** Ewa's plan: seven days from Tuesday 6 January 2026. */
  let ofEwa: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    households = t.app.get(HouseholdListsService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    adam = await aProfile(t, user, { name: 'Adam' });
    ewa = await aProfile(t, user, { name: 'Ewa', sex: 'female', weightKg: 62, heightCm: 166 });
    ofAdam = await aPlan(t, user, adam);
    ofEwa = await aPlan(t, user, ewa, { startDate: '2026-01-06' });
    // 6 and 7 January in both plans: porridge, then chicken or tofu, then tofu.
    await menu(ofAdam, '2026-01-06', [PORRIDGE, CHICKEN_RICE, TOFU_BOWL]);
    await menu(ofAdam, '2026-01-07', [PORRIDGE, TOFU_BOWL, TOFU_BOWL]);
    await menu(ofEwa, '2026-01-06', [PORRIDGE, CHICKEN_RICE, TOFU_BOWL]);
    await menu(ofEwa, '2026-01-07', [PORRIDGE, TOFU_BOWL, TOFU_BOWL]);
  });

  const ingredient = (slug: string) => t.prisma.ingredient.findUniqueOrThrow({ where: { slug } });

  /** Give a day of a plan exactly these recipes, one serving each: breakfast, lunch, dinner. */
  async function menu(plan: MealPlan, date: string, slugs: [string, string, string]) {
    const meals = plan.days.find((day) => day.date === date)!.meals;
    for (const [index, mealType] of (['breakfast', 'lunch', 'dinner'] as const).entries()) {
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: slugs[index]! } });
      await t.prisma.plannedMeal.update({
        where: { id: meals.find((meal) => meal.mealType === mealType)!.id },
        data: { recipeId: recipe.id, servings: 1, quantityScale: 1, source: 'CATALOGUE' },
      });
    }
  }

  /** Put stock into a profile's pantry directly, as the user's own entry would leave it. */
  async function stock(profile: Profile, slug: string, quantity: number) {
    await t.prisma.inventoryItem.create({
      data: {
        profileId: profile.id,
        ingredientId: (await ingredient(slug)).id,
        quantity,
        unit: 'g',
      },
    });
  }

  /** What a profile's pantry holds of an ingredient, in grams. */
  async function pantry(profile: Profile, slug: string): Promise<number> {
    const rows = await t.prisma.inventoryItem.findMany({
      where: { profileId: profile.id, ingredientId: (await ingredient(slug)).id },
    });
    return Math.round(rows.reduce((sum, row) => sum + row.quantity, 0) * 1000) / 1000;
  }

  const make = (fromDate = '2026-01-06', toDate = '2026-01-07', planIds = [ofAdam.id, ofEwa.id]) =>
    t.http().post('/api/household-lists').set(as(user)).send({ planIds, fromDate, toDate });

  type Row = HouseholdList['groups'][number]['items'][number];
  const rowOf = (list: HouseholdList, name: string): Row => {
    const row = list.groups.flatMap((group) => group.items).find((item) => item.name === name);
    if (!row) throw new Error(`no row "${name}"`);
    return row;
  };
  const edit = async (list: HouseholdList, name: string, patch: object): Promise<HouseholdList> =>
    (
      await t
        .http()
        .patch(`/api/household-lists/${list.id}/items/${rowOf(list, name).id}`)
        .set(as(user))
        .send(patch)
        .expect(200)
    ).body as HouseholdList;
  const listsOf = async (plan: MealPlan): Promise<ShoppingList[]> =>
    (await t.http().get(`/api/shopping-lists?planId=${plan.id}`).set(as(user)).expect(200))
      .body as ShoppingList[];

  it('sums what the plans need by ingredient, counts packs of the sum, and says who needs what', async () => {
    const made = (await make().expect(201)).body as HouseholdList;

    expect(made.parts.map((part) => [part.profile, part.fromDate, part.toDate])).toEqual([
      ['Adam', '2026-01-06', '2026-01-07'],
      ['Ewa', '2026-01-06', '2026-01-07'],
    ]);
    // 150 g of chicken each: one pack of 500 g for both, where each list alone asks for one.
    expect(rowOf(made, 'Chicken breast')).toMatchObject({
      totalQuantity: 300,
      toBuyQuantity: 300,
      packs: { count: 1, size: 500 },
      shares: [
        { profileId: adam.id, profile: 'Adam', totalQuantity: 150 },
        { profileId: ewa.id, profile: 'Ewa', totalQuantity: 150 },
      ],
    });
    expect(rowOf(made, 'Whole milk')).toMatchObject({ totalQuantity: 1000, packs: { count: 1 } });
    expect(made.stale).toBe(false);

    // Each plan has its part among its lists, and its days say they are on a list.
    const [part] = await listsOf(ofAdam);
    expect(part!.household).toEqual({ id: made.id, profiles: ['Adam', 'Ewa'] });
    const plan = (await t.http().get(`/api/meal-plans/${ofEwa.id}`).set(as(user)).expect(200))
      .body as MealPlan;
    expect(plan.days.map((day) => day.listed)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      (
        (await t.http().get('/api/household-lists').set(as(user)).expect(200))
          .body as HouseholdList[]
      ).map((list) => list.id),
    ).toEqual([made.id]);
  });

  it('takes of each plan the days it has, and refuses a plan with none of them', async () => {
    const made = (await make('2026-01-04', '2026-01-06').expect(201)).body as HouseholdList;
    expect(made.parts.map((part) => [part.profile, part.fromDate, part.toDate])).toEqual([
      ['Adam', '2026-01-05', '2026-01-06'],
      ['Ewa', '2026-01-06', '2026-01-06'],
    ]);
    // Adam's plan ends on the 11th.
    expect((await make('2026-01-12', '2026-01-12').expect(400)).body.error).toBe(
      'SHOPPING_RANGE_OUTSIDE_PLAN',
    );
  });

  it('takes one plan of each profile, of the account, two at least', async () => {
    const another = await aPlan(t, user, adam, { startDate: '2026-01-06' });
    expect((await make(undefined, undefined, [ofAdam.id, another.id]).expect(400)).body.error).toBe(
      'HOUSEHOLD_PROFILE_TWICE',
    );
    await make(undefined, undefined, [ofAdam.id]).expect(400);

    const stranger = await aUser(t);
    const theirs = await aPlan(t, stranger, await aProfile(t, stranger));
    expect((await make(undefined, undefined, [ofAdam.id, theirs.id]).expect(404)).body.error).toBe(
      'PLAN_NOT_FOUND',
    );
    const made = (await make().expect(201)).body as HouseholdList;
    expect(
      (await t.http().get(`/api/household-lists/${made.id}`).set(as(stranger)).expect(404)).body
        .error,
    ).toBe('HOUSEHOLD_LIST_NOT_FOUND');
  });

  it("counts what every chosen profile's pantry has at home", async () => {
    await stock(adam, 'chicken-breast', 100);
    const made = (await make().expect(201)).body as HouseholdList;

    expect(rowOf(made, 'Chicken breast')).toMatchObject({
      totalQuantity: 300,
      alreadyHaveQuantity: 100,
      toBuyQuantity: 200,
    });
  });

  it("puts what a pack holds over the needs into each profile's pantry by need, and takes it back on an untick", async () => {
    await stock(adam, 'chicken-breast', 100);
    let list = (await make().expect(201)).body as HouseholdList;

    // 100 g at home and a pack of 500 g: each plan has its 150 g, and the 300 g over go half and half.
    list = await edit(list, 'Chicken breast', { purchasedQuantity: 600 });
    expect(rowOf(list, 'Chicken breast')).toMatchObject({ purchasedQuantity: 600, checked: true });
    expect(await pantry(adam, 'chicken-breast')).toBe(150);
    expect(await pantry(ewa, 'chicken-breast')).toBe(150);

    list = await edit(list, 'Chicken breast', { checked: false });
    expect(rowOf(list, 'Chicken breast')).toMatchObject({ purchasedQuantity: 100, checked: false });
    expect(await pantry(adam, 'chicken-breast')).toBe(100);
    expect(await pantry(ewa, 'chicken-breast')).toBe(0);
  });

  it('shares what is said to be at home as the pantries had it, then where there is room', async () => {
    await stock(adam, 'chicken-breast', 100);
    let list = (await make().expect(201)).body as HouseholdList;

    list = await edit(list, 'Chicken breast', { alreadyHaveQuantity: 250 });
    expect(rowOf(list, 'Chicken breast')).toMatchObject({
      alreadyHaveQuantity: 250,
      toBuyQuantity: 50,
    });
    const [adamsPart] = await listsOf(ofAdam);
    const [ewasPart] = await listsOf(ofEwa);
    const chicken = (part: ShoppingList) =>
      part.groups.flatMap((group) => group.items).find((item) => item.name === 'Chicken breast')!;
    expect(chicken(adamsPart!).alreadyHaveQuantity).toBe(150);
    expect(chicken(ewasPart!).alreadyHaveQuantity).toBe(100);
  });

  it('takes two changes of a row at once one after the other', async () => {
    await stock(adam, 'chicken-breast', 100);
    const list = (await make().expect(201)).body as HouseholdList;
    const row = rowOf(list, 'Chicken breast');

    const answers = await race(2, () =>
      t
        .http()
        .patch(`/api/household-lists/${list.id}/items/${row.id}`)
        .set(as(user))
        .send({ purchasedQuantity: 600 }),
    );
    expect(answers.map((answer) => answer.status === 'fulfilled' && answer.value.status)).toEqual([
      200, 200,
    ]);
    expect(await pantry(adam, 'chicken-breast')).toBe(150);
    expect(await pantry(ewa, 'chicken-breast')).toBe(150);
  });

  it("is stale when a plan's menu of its days changed, and only that part is", async () => {
    const made = (await make().expect(201)).body as HouseholdList;
    await menu(ofEwa, '2026-01-07', [PORRIDGE, CHICKEN_RICE, CHICKEN_RICE]);

    const now = (await t.http().get(`/api/household-lists/${made.id}`).set(as(user)).expect(200))
      .body as HouseholdList;
    expect(now.stale).toBe(true);
    expect(now.parts.map((part) => [part.profile, part.stale])).toEqual([
      ['Adam', false],
      ['Ewa', true],
    ]);
  });

  it('gives back to each pantry what was obtained for the days ahead when it is deleted', async () => {
    await stock(adam, 'chicken-breast', 100);
    let list = (await make().expect(201)).body as HouseholdList;
    list = await edit(list, 'Chicken breast', { purchasedQuantity: 600 });

    // Deleted before its days: everything obtained is in the kitchen, in the pantry of the profile it was for.
    await households.remove(user.id, list.id, BEFORE);
    expect(await pantry(adam, 'chicken-breast')).toBe(300);
    expect(await pantry(ewa, 'chicken-breast')).toBe(300);
    expect(await listsOf(ofAdam)).toEqual([]);
    expect(await listsOf(ofEwa)).toEqual([]);
    await t.http().get(`/api/household-lists/${list.id}`).set(as(user)).expect(404);
  });

  it("leaves a plan's list alone once its plan is the last one in it", async () => {
    let made = (await make().expect(201)).body as HouseholdList;
    await t.http().delete(`/api/meal-plans/${ofEwa.id}`).set(as(user)).expect(204);
    await t.http().get(`/api/household-lists/${made.id}`).set(as(user)).expect(404);
    expect((await listsOf(ofAdam)).map((list) => list.household)).toEqual([null]);
    // Gone, not only out of sight: the account's file names no household list of one part.
    const kept = () => t.prisma.householdList.count();
    expect(await kept()).toBe(0);

    // A part replaced by a list of its plan alone, or a profile deleted, leaves the other part alone too.
    const again = await aPlan(t, user, ewa, { startDate: '2026-01-06' });
    made = (await make(undefined, undefined, [ofAdam.id, again.id]).expect(201))
      .body as HouseholdList;
    await t
      .http()
      .post('/api/shopping-lists/generate')
      .set(as(user))
      .send({ planId: again.id, fromDate: '2026-01-07', toDate: '2026-01-07' })
      .expect(201);
    await t.http().get(`/api/household-lists/${made.id}`).set(as(user)).expect(404);
    expect((await listsOf(ofAdam)).map((list) => list.household)).toEqual([null]);
    expect(await kept()).toBe(0);

    made = (await make(undefined, undefined, [ofAdam.id, again.id]).expect(201))
      .body as HouseholdList;
    await t.http().delete(`/api/profiles/${ewa.id}`).set(as(user)).expect(204);
    await t.http().get(`/api/household-lists/${made.id}`).set(as(user)).expect(404);
    expect((await listsOf(ofAdam)).map((list) => list.household)).toEqual([null]);
    expect(await kept()).toBe(0);
  });

  it('is replaced by one made again for the same days, which takes the place of its parts', async () => {
    const first = (await make().expect(201)).body as HouseholdList;
    const again = (await make().expect(201)).body as HouseholdList;

    expect(again.id).not.toBe(first.id);
    await t.http().get(`/api/household-lists/${first.id}`).set(as(user)).expect(404);
    expect((await listsOf(ofAdam)).map((list) => list.household?.id)).toEqual([again.id]);
    expect(await t.prisma.householdList.count()).toBe(1);
  });
});
