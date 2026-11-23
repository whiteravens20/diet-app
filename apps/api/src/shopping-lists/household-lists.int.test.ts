// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { HouseholdList, MealPlan, Profile, ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { HouseholdListsService } from './household-lists.service.js';
import { forgetLender } from './shopping-lists.service.js';

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
    // Three profiles in one kitchen, where the quick start allows two.
    t = await createTestApp({ MAX_PROFILES_PER_ACCOUNT: '3' });
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

  describe('one kitchen: a part its own pantry leaves short counts on the others', () => {
    // 540 g of tofu for each plan on the 6th and 7th: one bowl, then two.
    const TOFU = 'Firm tofu';
    type PartRow = ShoppingList['groups'][number]['items'][number];
    const tofuOf = async (plan: MealPlan): Promise<PartRow> => {
      const [part] = await listsOf(plan);
      return part!.groups.flatMap((group) => group.items).find((item) => item.name === TOFU)!;
    };

    it("counts what another profile's pantry holds beyond its own part, and takes it from there at once where it covers the part", async () => {
      await stock(adam, 'firm-tofu', 1100);
      const made = (await make().expect(201)).body as HouseholdList;

      expect(rowOf(made, TOFU)).toMatchObject({
        totalQuantity: 1080,
        alreadyHaveQuantity: 1080,
        toBuyQuantity: 0,
        checked: true,
        pantries: [{ profileId: adam.id, profile: 'Adam', quantity: 1080 }],
      });
      expect(await tofuOf(ofEwa)).toMatchObject({
        alreadyHaveQuantity: 540,
        checked: true,
        pantries: [{ profileId: adam.id, profile: 'Adam', quantity: 540 }],
      });
      // Both parts are covered: what they count on left Adam's pantry, and Ewa's has none to give.
      expect(await pantry(adam, 'firm-tofu')).toBe(20);
      expect(await pantry(ewa, 'firm-tofu')).toBe(0);
    });

    it('takes what it counted from the pantry it counted it in on a tick, and returns it there on an untick', async () => {
      await stock(adam, 'firm-tofu', 700);
      let list = (await make().expect(201)).body as HouseholdList;
      // Adam's part is covered by his pantry; Ewa's counts on the 160 g left in it.
      expect(rowOf(list, TOFU)).toMatchObject({
        alreadyHaveQuantity: 700,
        toBuyQuantity: 380,
        checked: false,
      });
      expect(await tofuOf(ofEwa)).toMatchObject({ alreadyHaveQuantity: 160, checked: false });
      expect(await pantry(adam, 'firm-tofu')).toBe(160);

      list = await edit(list, TOFU, { purchasedQuantity: 1080 });
      expect(rowOf(list, TOFU)).toMatchObject({ checked: true });
      expect(await pantry(adam, 'firm-tofu')).toBe(0);
      expect(await pantry(ewa, 'firm-tofu')).toBe(0);

      list = await edit(list, TOFU, { checked: false });
      expect(rowOf(list, TOFU)).toMatchObject({ checked: false });
      expect(await pantry(adam, 'firm-tofu')).toBe(700);
      expect(await pantry(ewa, 'firm-tofu')).toBe(0);
    });

    it('counts on the other pantries in the order of their profiles', async () => {
      const ola = await aProfile(t, user, {
        name: 'Ola',
        sex: 'female',
        weightKg: 58,
        heightCm: 160,
      });
      const ofOla = await aPlan(t, user, ola, { startDate: '2026-01-06' });
      await menu(ofOla, '2026-01-06', [PORRIDGE, CHICKEN_RICE, TOFU_BOWL]);
      await menu(ofOla, '2026-01-07', [PORRIDGE, TOFU_BOWL, TOFU_BOWL]);
      // Ewa has none; beyond their own parts Adam has 160 g and Ola 460 g.
      await stock(adam, 'firm-tofu', 700);
      await stock(ola, 'firm-tofu', 1000);
      await make(undefined, undefined, [ofAdam.id, ofEwa.id, ofOla.id]).expect(201);

      const [first, second] = [
        { profile: adam, free: 160 },
        { profile: ola, free: 460 },
      ].sort((a, b) => (a.profile.id < b.profile.id ? -1 : 1));
      const fromFirst = Math.min(first!.free, 540);
      expect((await tofuOf(ofEwa)).pantries).toEqual([
        { profileId: first!.profile.id, profile: first!.profile.name, quantity: fromFirst },
        { profileId: second!.profile.id, profile: second!.profile.name, quantity: 540 - fromFirst },
      ]);
      // Covered by the two: taken from both at once.
      expect((await pantry(adam, 'firm-tofu')) + (await pantry(ola, 'firm-tofu'))).toBe(80);
    });

    it("does not count again on what another profile's part counts on", async () => {
      await stock(adam, 'firm-tofu', 700);
      await make().expect(201);
      // A list of Adam's later day: the 160 g in his pantry are Ewa's part's, not yet taken.
      await menu(ofAdam, '2026-01-08', [PORRIDGE, TOFU_BOWL, TOFU_BOWL]);
      const later = (
        await t
          .http()
          .post('/api/shopping-lists/generate')
          .set(as(user))
          .send({ planId: ofAdam.id, fromDate: '2026-01-08', toDate: '2026-01-08' })
          .expect(201)
      ).body as ShoppingList;
      expect(
        later.groups.flatMap((group) => group.items).find((item) => item.name === TOFU),
      ).toMatchObject({ totalQuantity: 360, alreadyHaveQuantity: 0 });
    });

    it("counts of a part's own pantry only what is at home from it, not what it counts on in another", async () => {
      await stock(adam, 'firm-tofu', 700);
      await stock(ewa, 'firm-tofu', 100);
      await make().expect(201);
      // Ewa's part: her 100 g and the 160 g Adam's pantry holds beyond his part, short of 540 and so not taken.
      expect(await tofuOf(ofEwa)).toMatchObject({ alreadyHaveQuantity: 260, checked: false });

      // 300 g more in her pantry since: a list of her later day has them at home, her part keeping its 100 g.
      await t.prisma.inventoryItem.updateMany({
        where: { profileId: ewa.id },
        data: { quantity: 400 },
      });
      await menu(ofEwa, '2026-01-08', [PORRIDGE, TOFU_BOWL, TOFU_BOWL]);
      const later = (
        await t
          .http()
          .post('/api/shopping-lists/generate')
          .set(as(user))
          .send({ planId: ofEwa.id, fromDate: '2026-01-08', toDate: '2026-01-08' })
          .expect(201)
      ).body as ShoppingList;
      expect(
        later.groups.flatMap((group) => group.items).find((item) => item.name === TOFU),
      ).toMatchObject({ totalQuantity: 360, alreadyHaveQuantity: 300 });
    });

    it('gives back to each pantry what came from it when it is deleted before its days', async () => {
      await stock(adam, 'firm-tofu', 700);
      let list = (await make().expect(201)).body as HouseholdList;
      list = await edit(list, TOFU, { purchasedQuantity: 1080 });

      await households.remove(user.id, list.id, BEFORE);
      // Adam's 700 g where they were; the 380 g bought for Ewa's part in her pantry.
      expect(await pantry(adam, 'firm-tofu')).toBe(700);
      expect(await pantry(ewa, 'firm-tofu')).toBe(380);
    });

    it("gives back to another profile's pantry what a part took from it at once when it is deleted before its days", async () => {
      await stock(adam, 'firm-tofu', 1100);
      const list = (await make().expect(201)).body as HouseholdList;
      expect(await pantry(adam, 'firm-tofu')).toBe(20);

      await households.remove(user.id, list.id, BEFORE);
      expect(await pantry(adam, 'firm-tofu')).toBe(1100);
      expect(await pantry(ewa, 'firm-tofu')).toBe(0);
    });

    it("counts on no more than the other's pantry still holds once it holds less", async () => {
      await stock(adam, 'firm-tofu', 700);
      await make().expect(201);
      const [row] = await t.prisma.inventoryItem.findMany({ where: { profileId: adam.id } });
      await t
        .http()
        .patch(`/api/inventory/${row!.id}`)
        .set(as(user))
        .send({ quantity: 60 })
        .expect(200);

      expect(await tofuOf(ofEwa)).toMatchObject({
        alreadyHaveQuantity: 60,
        pantries: [{ profileId: adam.id, profile: 'Adam', quantity: 60 }],
      });
    });

    it("takes what is said to be at home as the part's own, giving back what it counted elsewhere", async () => {
      await stock(adam, 'firm-tofu', 700);
      let list = (await make().expect(201)).body as HouseholdList;
      list = await edit(list, TOFU, { alreadyHaveQuantity: 300 });

      expect(rowOf(list, TOFU)).toMatchObject({ alreadyHaveQuantity: 300, toBuyQuantity: 780 });
      expect((await tofuOf(ofEwa)).pantries).toEqual([]);
      // Adam's part no longer covered: its tick and what it took are undone.
      expect(await pantry(adam, 'firm-tofu')).toBe(700);
    });

    it("keeps a part's ticked count on a pantry once the other plan is gone, and drops one not ticked", async () => {
      await stock(adam, 'firm-tofu', 700);
      await make().expect(201);
      await t.http().delete(`/api/meal-plans/${ofAdam.id}`).set(as(user)).expect(204);
      // Ewa's part is her plan's list alone: what it counted in Adam's pantry is not at home for it any more.
      expect(await tofuOf(ofEwa)).toMatchObject({ alreadyHaveQuantity: 0, pantries: [] });

      const again = await aPlan(t, user, adam, { startDate: '2026-01-06' });
      await menu(again, '2026-01-06', [PORRIDGE, CHICKEN_RICE, TOFU_BOWL]);
      await menu(again, '2026-01-07', [PORRIDGE, TOFU_BOWL, TOFU_BOWL]);
      // What his pantry holds now: enough for both parts.
      await t.prisma.inventoryItem.updateMany({
        where: { profileId: adam.id },
        data: { quantity: 1080 },
      });
      await make(undefined, undefined, [again.id, ofEwa.id]).expect(201);
      expect(await pantry(adam, 'firm-tofu')).toBe(0);
      await t.http().delete(`/api/meal-plans/${again.id}`).set(as(user)).expect(204);
      // Ticked: it keeps what it took, and taking the tick back returns it to Adam's pantry.
      const kept = await tofuOf(ofEwa);
      expect(kept).toMatchObject({
        checked: true,
        pantries: [{ profileId: adam.id, quantity: 540 }],
      });
      const [part] = await listsOf(ofEwa);
      await t
        .http()
        .patch(`/api/shopping-lists/${part!.id}/items/${kept.id}`)
        .set(as(user))
        .send({ checked: false })
        .expect(200);
      expect(await pantry(adam, 'firm-tofu')).toBe(540);
    });

    it('forgets what was counted in the pantry of a profile that is deleted', async () => {
      await stock(adam, 'firm-tofu', 700);
      await make().expect(201);
      await t.http().delete(`/api/profiles/${adam.id}`).set(as(user)).expect(204);

      expect(await tofuOf(ofEwa)).toMatchObject({ alreadyHaveQuantity: 0, pantries: [] });
    });

    it('gives back to the other pantries what the lists of a profile that is deleted took from them for the days ahead', async () => {
      await stock(adam, 'firm-tofu', 1100);
      await make().expect(201);
      expect(await pantry(adam, 'firm-tofu')).toBe(20);

      // Ewa's part took its 540 g from Adam's pantry, every one of its days still ahead.
      await t.prisma.$transaction((tx) => forgetLender(tx, ewa.id, BEFORE));
      expect(await pantry(adam, 'firm-tofu')).toBe(560);
    });

    it('forgets what the parts took from a row of a pantry that is removed, so that none of it comes back', async () => {
      await stock(adam, 'firm-tofu', 1100);
      const list = (await make().expect(201)).body as HouseholdList;
      const [row] = await t.prisma.inventoryItem.findMany({ where: { profileId: adam.id } });
      await t.http().delete(`/api/inventory/${row!.id}`).set(as(user)).expect(204);

      // What both parts took went with the row: neither has it at home any more, nor is ticked.
      expect(await tofuOf(ofAdam)).toMatchObject({ alreadyHaveQuantity: 0, checked: false });
      expect(await tofuOf(ofEwa)).toMatchObject({
        alreadyHaveQuantity: 0,
        checked: false,
        pantries: [],
      });
      await households.remove(user.id, list.id, BEFORE);
      expect(await pantry(adam, 'firm-tofu')).toBe(0);
      expect(await pantry(ewa, 'firm-tofu')).toBe(0);
    });
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
