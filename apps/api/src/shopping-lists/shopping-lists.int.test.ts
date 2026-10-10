// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { MAX_LISTS_PER_PLAN, MAX_QUANTITY, type MealPlan, type Profile, type ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { netEffect, pantryStock } from '../engine/pantry.js';
import { readMoves } from '../inventory/pantry-store.js';
import { MealPlansService } from '../meal-plans/meal-plans.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ShoppingListsService } from './shopping-lists.service.js';

/** The fixture recipes the menus below are made of, with what one serving takes. */
const EGGS_ON_TOAST = 'scrambled-eggs-on-toast'; // 165 g large egg (3), 70 g bread (2 slices), 5 ml oil
const PORRIDGE = 'milk-porridge'; // 60 g oats, 250 ml milk
const TOFU_BOWL = 'tofu-rice-bowl'; // 180 g tofu, 80 g rice, 100 g broccoli, 5 ml oil
const CHICKEN_RICE = 'chicken-rice-broccoli'; // 150 g chicken, 80 g rice, 150 g broccoli, 10 ml oil

/** Long before the plans below begin, and long after they end. */
const BEFORE = new Date('2025-12-01');
const AFTER = new Date('2026-03-01');

describe('shopping lists and the pantry', () => {
  let t: TestApp;
  let lists: ShoppingListsService;
  let plans: MealPlansService;
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    lists = t.app.get(ShoppingListsService);
    plans = t.app.get(MealPlansService);
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
    // Fourteen days from Monday 5 January 2026, three meals a day.
    plan = await aPlan(t, user, profile, { durationDays: 14 });
  });

  const ingredient = (slug: string) => t.prisma.ingredient.findUniqueOrThrow({ where: { slug } });
  const date = (day: number): string => plan.days[day]!.date;

  /** Give a day of the plan exactly these recipes, one serving each: breakfast, lunch, dinner. */
  async function menu(day: number, slugs: [string, string, string]): Promise<void> {
    const meals = plan.days[day]!.meals;
    for (const [index, mealType] of (['breakfast', 'lunch', 'dinner'] as const).entries()) {
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: slugs[index]! } });
      const meal = meals.find((m) => m.mealType === mealType)!;
      await t.prisma.plannedMeal.update({
        where: { id: meal.id },
        data: { recipeId: recipe.id, servings: 1, quantityScale: 1, source: 'CATALOGUE', eatenAt: null },
      });
    }
  }

  /** Put stock into the pantry directly, as the user's own entry would leave it. */
  async function stock(slug: string, quantity: number, unit: 'g' | 'ml' | 'piece', bestBefore: string | null = null): Promise<void> {
    await t.prisma.inventoryItem.create({
      data: { profileId: profile.id, ingredientId: (await ingredient(slug)).id, quantity, unit, bestBefore: bestBefore ? new Date(bestBefore) : null },
    });
  }

  /** The pantry rows of an ingredient as text, in a fixed order. */
  async function pantry(slug: string): Promise<string[]> {
    const rows = await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id, ingredientId: (await ingredient(slug)).id } });
    return rows.map((row) => `${Math.round(row.quantity * 1000) / 1000} ${row.unit}`).sort();
  }

  /** A list for one day of the plan, or for a run of days. */
  const listFor = (from: number, to: number = from): Promise<ShoppingList> =>
    lists.generate(user.id, 'en', { planId: plan.id, fromDate: date(from), toDate: date(to) });

  type Row = ShoppingList['groups'][number]['items'][number];
  const rows = (list: ShoppingList): Row[] => list.groups.flatMap((group) => group.items);
  const rowOf = (list: ShoppingList, name: string): Row => {
    const row = rows(list).find((item) => item.name === name);
    if (!row) throw new Error(`no row "${name}" among ${rows(list).map((item) => item.name).join(', ')}`);
    return row;
  };

  const edit = async (list: ShoppingList, name: string, patch: { checked?: boolean; purchasedQuantity?: number | null }): Promise<Row> =>
    rowOf(await lists.updateItem(user.id, 'en', list.id, rowOf(list, name).id, patch), name);

  describe('a list', () => {
    beforeEach(() => menu(0, [EGGS_ON_TOAST, TOFU_BOWL, CHICKEN_RICE]));

    it('counts eggs and bread in pieces, everything else by weight or volume, and asks for what one buys', async () => {
      const list = await listFor(0);

      expect(rowOf(list, 'Large egg')).toMatchObject({ totalQuantity: 3, unit: 'piece', displayUnit: 'piece' });
      expect(rowOf(list, 'Wholegrain bread')).toMatchObject({ totalQuantity: 2, unit: 'piece', displayUnit: 'slice' });
      expect(rowOf(list, 'Olive oil')).toMatchObject({ totalQuantity: 20, unit: 'ml', displayUnit: 'ml' });
      expect(rowOf(list, 'White rice')).toMatchObject({ totalQuantity: 160, unit: 'g', displayUnit: 'g' });
      expect(rowOf(list, 'Broccoli')).toMatchObject({ totalQuantity: 250, toBuyQuantity: 250, alreadyHaveQuantity: 0, purchasedQuantity: null, checked: false });
      expect(list.stale).toBe(false);
    });

    it('rounds a need up, never down: a scaled meal that takes 3.3 eggs asks for four', async () => {
      const breakfast = plan.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
      await t.prisma.plannedMeal.update({ where: { id: breakfast.id }, data: { quantityScale: 1.1 } });

      const list = await listFor(0);

      expect(rowOf(list, 'Large egg').totalQuantity).toBe(4);
      // 77 g of bread are 2.2 slices.
      expect(rowOf(list, 'Wholegrain bread').totalQuantity).toBe(3);
    });

    it('comes in aisle order, and stays in it after rows are edited', async () => {
      const list = await listFor(0);
      const aisles = list.groups.map((group) => group.category);
      expect(aisles).toEqual(['vegetables', 'meat', 'dairy', 'grains', 'legumes', 'fats_oils']);

      await edit(list, 'Broccoli', { checked: true });
      await edit(list, 'Chicken breast', { purchasedQuantity: 40 });
      const again = await lists.get(user.id, 'en', list.id);

      expect(again.groups.map((group) => group.category)).toEqual(aisles);
      expect(rows(again).map((row) => row.name)).toEqual(rows(list).map((row) => row.name));
    });

    it("names its rows in the reader's language", async () => {
      const list = await listFor(0);

      const polish = await lists.get(user.id, 'pl', list.id);

      expect(rows(polish).map((row) => row.name)).toContain('Jajko');
      expect(rows(polish).map((row) => row.name)).toContain('Brokuł');
    });

    it('says when the menu no longer needs what it lists', async () => {
      const list = await listFor(0);
      expect((await lists.get(user.id, 'en', list.id)).stale).toBe(false);

      await menu(0, [PORRIDGE, TOFU_BOWL, CHICKEN_RICE]);

      expect((await lists.get(user.id, 'en', list.id)).stale).toBe(true);
      const all = await lists.listForPlan(user.id, 'en', plan.id);
      expect(all.map((entry) => entry.stale)).toEqual([true]);
    });

    it('is not stale because another day of the plan changed', async () => {
      const list = await listFor(0);

      await menu(1, [PORRIDGE, PORRIDGE, PORRIDGE]);

      expect((await lists.get(user.id, 'en', list.id)).stale).toBe(false);
    });
  });

  describe('eggs kept in pieces', () => {
    // Three breakfasts of three eggs each: nine eggs.
    beforeEach(async () => {
      for (const day of [0, 1, 2]) await menu(day, [EGGS_ON_TOAST, TOFU_BOWL, CHICKEN_RICE]);
      await stock('large-egg', 6, 'piece');
    });

    it('are counted on, are used up when the row is ticked, and come back as pieces when it is unticked', async () => {
      const list = await listFor(0, 2);
      expect(rowOf(list, 'Large egg')).toMatchObject({ totalQuantity: 9, alreadyHaveQuantity: 6, toBuyQuantity: 3, purchasedQuantity: 6, checked: false });
      // Counting on stock takes nothing yet.
      expect(await pantry('large-egg')).toEqual(['6 piece']);

      const ticked = await edit(list, 'Large egg', { checked: true });
      expect(ticked).toMatchObject({ purchasedQuantity: 9, checked: true });
      expect(await pantry('large-egg')).toEqual([]);

      await edit(list, 'Large egg', { checked: false });
      // Six pieces, and no row in grams made out of nothing.
      expect(await pantry('large-egg')).toEqual(['6 piece']);

      await edit(list, 'Large egg', { checked: true });
      await edit(list, 'Large egg', { checked: false });
      await edit(list, 'Large egg', { checked: true });
      expect(await pantry('large-egg')).toEqual([]);
      await edit(list, 'Large egg', { checked: false });
      expect(await pantry('large-egg')).toEqual(['6 piece']);
    });

    it('take the extra eggs of a box of ten as pieces', async () => {
      const list = await listFor(0, 2);

      // Six at home and a box of ten: sixteen, seven more than the nine needed.
      await edit(list, 'Large egg', { purchasedQuantity: 16 });

      expect(await pantry('large-egg')).toEqual(['7 piece']);
    });

    it('are used alongside eggs kept in grams, what expires first going first', async () => {
      await t.prisma.inventoryItem.deleteMany({ where: { profileId: profile.id } });
      await stock('large-egg', 4, 'piece', '2026-02-01');
      await stock('large-egg', 165, 'g', '2026-01-10');

      const list = await listFor(0, 2);
      // Four pieces and 165 g are seven eggs.
      expect(rowOf(list, 'Large egg')).toMatchObject({ alreadyHaveQuantity: 7, pantryBestBefore: '2026-01-10' });

      await edit(list, 'Large egg', { purchasedQuantity: 5 });
      await edit(list, 'Large egg', { checked: true });
      // Closed at five eggs: all seven the list counted on are taken all the same.
      expect(await pantry('large-egg')).toEqual([]);

      await edit(list, 'Large egg', { checked: false });
      expect(await pantry('large-egg')).toEqual(['165 g', '4 piece']);
      const restored = await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id }, orderBy: { unit: 'asc' } });
      expect(restored.map((row) => row.bestBefore?.toISOString().slice(0, 10))).toEqual(['2026-01-10', '2026-02-01']);
    });
  });

  describe('a need the pantry covers in full', () => {
    beforeEach(() => menu(0, [EGGS_ON_TOAST, TOFU_BOWL, CHICKEN_RICE]));

    it('arrives ticked, and what it counts on leaves the pantry at once', async () => {
      await stock('large-egg', 8, 'piece');
      await stock('white-rice', 1000, 'g');

      const list = await listFor(0);

      expect(rowOf(list, 'Large egg')).toMatchObject({ alreadyHaveQuantity: 3, toBuyQuantity: 0, purchasedQuantity: 3, checked: true });
      expect(await pantry('large-egg')).toEqual(['5 piece']);
      expect(await pantry('white-rice')).toEqual(['840 g']);
    });

    it('does not count on a fraction of an egg or on the last grams of a bag', async () => {
      await stock('large-egg', 2.6, 'piece');
      await stock('broccoli', 237.5, 'g');

      const list = await listFor(0);

      expect(rowOf(list, 'Large egg')).toMatchObject({ alreadyHaveQuantity: 2, toBuyQuantity: 1 });
      expect(rowOf(list, 'Broccoli')).toMatchObject({ alreadyHaveQuantity: 235, toBuyQuantity: 15 });
    });
  });

  describe('the ledger of a row', () => {
    beforeEach(() => menu(0, [PORRIDGE, TOFU_BOWL, CHICKEN_RICE]));

    it('records what was taken, not what was meant: stock the user used up meanwhile does not come back', async () => {
      await stock('white-rice', 100, 'g');
      const list = await listFor(0);
      expect(rowOf(list, 'White rice')).toMatchObject({ totalQuantity: 160, alreadyHaveQuantity: 100 });
      // The user cooks half of it and corrects the pantry by hand.
      await t.prisma.inventoryItem.updateMany({ where: { profileId: profile.id }, data: { quantity: 50 } });

      await edit(list, 'White rice', { checked: true });
      expect(await pantry('white-rice')).toEqual([]);

      await edit(list, 'White rice', { checked: false });
      // 50 g, not the 100 g the list once counted on.
      expect(await pantry('white-rice')).toEqual(['50 g']);
    });

    it('adds what was bought beyond the need, and takes it back when the purchase is corrected', async () => {
      const list = await listFor(0);

      await edit(list, 'White rice', { purchasedQuantity: 500 });
      expect(await pantry('white-rice')).toEqual(['340 g']);

      await edit(list, 'White rice', { purchasedQuantity: 200 });
      expect(await pantry('white-rice')).toEqual(['40 g']);

      await edit(list, 'White rice', { purchasedQuantity: 100 });
      expect(await pantry('white-rice')).toEqual([]);
      expect(rowOf(await lists.get(user.id, 'en', list.id), 'White rice').checked).toBe(false);
    });

    it('takes a tick on a row nobody typed in as having all of it', async () => {
      await stock('white-rice', 100, 'g');
      const list = await listFor(0);

      const ticked = await edit(list, 'White rice', { checked: true });

      expect(ticked).toMatchObject({ purchasedQuantity: 160, checked: true });
    });

    it('applies an edit once when two requests for it arrive together', async () => {
      const list = await listFor(0);
      const rice = rowOf(list, 'White rice');

      const results = await race(4, () => lists.updateItem(user.id, 'en', list.id, rice.id, { purchasedQuantity: 260 }));

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
      expect(await pantry('white-rice')).toEqual(['100 g']);
    });

    it('takes stock once when a row is ticked twice at the same moment', async () => {
      await stock('white-rice', 500, 'g');
      await menu(0, [PORRIDGE, TOFU_BOWL, TOFU_BOWL]);
      await t.prisma.inventoryItem.updateMany({ where: { profileId: profile.id }, data: { quantity: 100 } });
      const list = await listFor(0);
      const rice = rowOf(list, 'White rice');
      expect(rice).toMatchObject({ alreadyHaveQuantity: 100, checked: false });
      await t.prisma.inventoryItem.updateMany({ where: { profileId: profile.id }, data: { quantity: 500 } });

      await race(3, () => lists.updateItem(user.id, 'en', list.id, rice.id, { checked: true }));

      expect(await pantry('white-rice')).toEqual(['400 g']);
    });

    it('refuses a quantity no kitchen holds', async () => {
      await menu(0, [EGGS_ON_TOAST, TOFU_BOWL, CHICKEN_RICE]);
      const list = await listFor(0);
      const path = `/api/shopping-lists/${list.id}/items/${rowOf(list, 'Large egg').id}`;

      const tooManyEggs = await t.http().patch(path).set(as(user)).send({ purchasedQuantity: MAX_QUANTITY.piece + 1 });
      const absurd = await t.http().patch(path).set(as(user)).send({ purchasedQuantity: 1e12 });

      expect(tooManyEggs.status).toBe(400);
      expect(tooManyEggs.body.error).toBe('QUANTITY_TOO_LARGE');
      expect(absurd.status).toBe(400);
      expect(await pantry('large-egg')).toEqual([]);
    });
  });

  describe('two lists of one profile', () => {
    // Day one needs 120 g of oats, day two 60 g.
    beforeEach(async () => {
      await menu(0, [PORRIDGE, PORRIDGE, TOFU_BOWL]);
      await menu(1, [PORRIDGE, TOFU_BOWL, CHICKEN_RICE]);
      await stock('rolled-oats', 100, 'g');
    });

    it('do not both count on the same stock', async () => {
      const first = await listFor(0);
      const second = await listFor(1);

      expect(rowOf(first, 'Rolled oats')).toMatchObject({ totalQuantity: 120, alreadyHaveQuantity: 100, toBuyQuantity: 20 });
      // The 100 g are spoken for.
      expect(rowOf(second, 'Rolled oats')).toMatchObject({ totalQuantity: 60, alreadyHaveQuantity: 0, toBuyQuantity: 60 });
    });

    it('see stock again once the list that counted on it has taken it', async () => {
      const first = await listFor(0);
      await edit(first, 'Rolled oats', { purchasedQuantity: 300 });
      // 100 g taken, 180 g beyond the need put in.
      expect(await pantry('rolled-oats')).toEqual(['180 g']);

      const second = await listFor(1);

      expect(rowOf(second, 'Rolled oats')).toMatchObject({ alreadyHaveQuantity: 60, checked: true });
      expect(await pantry('rolled-oats')).toEqual(['120 g']);
    });

    it('count on the stock of another plan of the same profile as taken, too', async () => {
      await listFor(0);
      const otherPlan = await aPlan(t, user, profile, { startDate: '2026-02-02' });
      const breakfast = otherPlan.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
      const porridge = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: PORRIDGE } });
      await t.prisma.plannedMeal.update({ where: { id: breakfast.id }, data: { recipeId: porridge.id, servings: 1, quantityScale: 1 } });

      const other = await lists.generate(user.id, 'en', { planId: otherPlan.id, fromDate: otherPlan.days[0]!.date, toDate: otherPlan.days[0]!.date });

      expect(rowOf(other, 'Rolled oats').alreadyHaveQuantity).toBe(0);
    });

    it('are made one after the other when asked for at the same moment', async () => {
      const results = await race(2, (index) => listFor(index));

      const claims = results.map((result) => (result.status === 'fulfilled' ? rowOf(result.value, 'Rolled oats').alreadyHaveQuantity : -1)).sort();
      // One of them got the stock; they did not both get it.
      expect(claims.reduce((sum, claim) => sum + claim, 0)).toBeLessThanOrEqual(100);
      expect(claims).not.toContain(-1);
    });
  });

  describe('removing a list', () => {
    beforeEach(async () => {
      await menu(0, [PORRIDGE, TOFU_BOWL, CHICKEN_RICE]);
      await stock('white-rice', 100, 'g');
    });

    /** A list whose rice row is ticked with 500 g: 100 g from the pantry, 400 g bought, 340 g beyond the need. */
    async function shopped(): Promise<ShoppingList> {
      const list = await listFor(0);
      await edit(list, 'White rice', { purchasedQuantity: 500 });
      await edit(list, 'Broccoli', { purchasedQuantity: 100 });
      expect(await pantry('white-rice')).toEqual(['340 g']);
      return list;
    }

    it('before its days puts everything obtained for it into the pantry: it is in the kitchen', async () => {
      const list = await shopped();

      await lists.remove(user.id, list.id, BEFORE);

      // The 100 g it began with and the 400 g that were bought.
      expect(await pantry('white-rice')).toEqual(['500 g']);
      // Bought but never ticked.
      expect(await pantry('broccoli')).toEqual(['100 g']);
      expect(await t.prisma.shoppingList.count()).toBe(0);
    });

    it('after its days leaves the pantry as it is: the food was eaten', async () => {
      const list = await shopped();

      await lists.remove(user.id, list.id, AFTER);

      expect(await pantry('white-rice')).toEqual(['340 g']);
      expect(await pantry('broccoli')).toEqual([]);
    });

    it('part-way through returns the share of the days still ahead', async () => {
      await menu(1, [PORRIDGE, TOFU_BOWL, CHICKEN_RICE]);
      const list = await listFor(0, 1);
      await edit(list, 'White rice', { purchasedQuantity: 320 });
      // All 320 g are needed: 100 g left the pantry, nothing was put in.
      expect(await pantry('white-rice')).toEqual([]);

      // On the second of its two days: half is eaten.
      await lists.remove(user.id, list.id, new Date(date(1)));

      expect(await pantry('white-rice')).toEqual(['160 g']);
    });

    it('that nobody touched changes nothing', async () => {
      const list = await listFor(0);

      await lists.remove(user.id, list.id, BEFORE);

      expect(await pantry('white-rice')).toEqual(['100 g']);
    });

    it('over HTTP answers 204 and then 404', async () => {
      const list = await listFor(0);

      await t.http().delete(`/api/shopping-lists/${list.id}`).set(as(user)).expect(204);
      await t.http().get(`/api/shopping-lists/${list.id}`).set(as(user)).expect(404);
    });

    it('happens with its plan, by the same rule', async () => {
      // This plan lies in the past, so its food counts as eaten.
      await shopped();
      await plans.remove(user.id, plan.id);
      expect(await pantry('white-rice')).toEqual(['340 g']);
      expect(await t.prisma.shoppingList.count()).toBe(0);

      // One that has not begun gives everything back.
      await t.prisma.inventoryItem.deleteMany({ where: { profileId: profile.id } });
      await stock('white-rice', 100, 'g');
      const future = await aPlan(t, user, profile, { startDate: '2031-01-06' });
      const made = await lists.generate(user.id, 'en', { planId: future.id });
      const rice = rowOf(made, 'White rice');
      await lists.updateItem(user.id, 'en', made.id, rice.id, { purchasedQuantity: rice.totalQuantity + 50 });
      const before = pantryStock(await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id } }), await ingredient('white-rice')).quantity;

      await plans.remove(user.id, future.id);

      const after = pantryStock(await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id } }), await ingredient('white-rice')).quantity;
      // Everything obtained: what the pantry held to begin with plus all that was bought.
      expect(after).toBe(100 + (rice.totalQuantity + 50 - rice.alreadyHaveQuantity));
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('making a list for days that already have one', () => {
    beforeEach(async () => {
      await menu(0, [PORRIDGE, TOFU_BOWL, CHICKEN_RICE]);
      await menu(1, [PORRIDGE, TOFU_BOWL, CHICKEN_RICE]);
    });

    it('replaces it, and counts what was obtained for it', async () => {
      const first = await listFor(0);
      await edit(first, 'White rice', { purchasedQuantity: 160 });
      expect(await pantry('white-rice')).toEqual([]);

      const second = await listFor(0);

      expect(await t.prisma.shoppingList.count({ where: { planId: plan.id } })).toBe(1);
      expect(second.id).not.toBe(first.id);
      // The 160 g bought for the first list are what the second finds at home.
      expect(rowOf(second, 'White rice')).toMatchObject({ alreadyHaveQuantity: 160, toBuyQuantity: 0, checked: true });
      expect(await pantry('white-rice')).toEqual([]);
    });

    it('replaces every list it overlaps, and leaves the others', async () => {
      await menu(2, [PORRIDGE, TOFU_BOWL, CHICKEN_RICE]);
      const dayOne = await listFor(0);
      const dayThree = await listFor(2);
      await edit(dayOne, 'White rice', { purchasedQuantity: 160 });

      const both = await listFor(0, 1);

      const left = await lists.listForPlan(user.id, 'en', plan.id);
      expect(left.map((list) => list.id).sort()).toEqual([both.id, dayThree.id].sort());
      // Two days need 320 g; the 160 g bought for day one are counted.
      expect(rowOf(both, 'White rice')).toMatchObject({ totalQuantity: 320, alreadyHaveQuantity: 160, toBuyQuantity: 160 });
    });

    it('asks only for what changed after the menu did', async () => {
      const first = await listFor(0);
      for (const row of rows(first)) await lists.updateItem(user.id, 'en', first.id, row.id, { checked: true });
      // Chicken out, a second tofu bowl in.
      await menu(0, [PORRIDGE, TOFU_BOWL, TOFU_BOWL]);
      expect((await lists.get(user.id, 'en', first.id)).stale).toBe(true);

      const second = await listFor(0);

      expect(second.stale).toBe(false);
      expect(rowOf(second, 'White rice')).toMatchObject({ totalQuantity: 160, checked: true });
      expect(rowOf(second, 'Firm tofu')).toMatchObject({ totalQuantity: 360, alreadyHaveQuantity: 180, toBuyQuantity: 180, checked: false });
      // What is no longer needed stays in the pantry: it was bought.
      expect(await pantry('chicken-breast')).toEqual(['150 g']);
    });
  });

  describe('the dates of a list', () => {
    it('default to the whole plan', async () => {
      const list = await lists.generate(user.id, 'en', { planId: plan.id });

      expect(list).toMatchObject({ fromDate: date(0), toDate: date(13) });
    });

    it.each([
      ['end before they begin', () => ({ fromDate: date(3), toDate: date(1) })],
      ['begin before the plan does', () => ({ fromDate: '2025-12-30', toDate: date(1) })],
      ['end after the plan does', () => ({ fromDate: date(1), toDate: '2026-03-01' })],
      ['lie outside the plan altogether', () => ({ fromDate: '2027-01-01', toDate: '2027-01-07' })],
    ])('are refused when they %s, and no list is stored', async (_name, range) => {
      const res = await t.http().post('/api/shopping-lists/generate').set(as(user)).send({ planId: plan.id, ...range() });

      expect(res.status).toBe(400);
      expect(await t.prisma.shoppingList.count()).toBe(0);
    });

    it('name the plan they must lie within', async () => {
      const res = await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(user))
        .send({ planId: plan.id, fromDate: '2027-01-01', toDate: '2027-01-07' })
        .expect(400);

      expect(res.body.error).toBe('SHOPPING_RANGE_OUTSIDE_PLAN');
    });
  });

  it('a plan holds a limited number of lists', async () => {
    for (let day = 0; day < MAX_LISTS_PER_PLAN; day += 1) await listFor(day);

    const res = await t
      .http()
      .post('/api/shopping-lists/generate')
      .set(as(user))
      .send({ planId: plan.id, fromDate: date(MAX_LISTS_PER_PLAN), toDate: date(MAX_LISTS_PER_PLAN) });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SHOPPING_LIST_LIMIT');
    // Replacing one of them is not one more.
    expect((await listFor(0)).fromDate).toBe(date(0));
    expect(await t.prisma.shoppingList.count({ where: { planId: plan.id } })).toBe(MAX_LISTS_PER_PLAN);
  });

  it("another user's plan and lists are out of reach", async () => {
    const list = await listFor(0);
    const other = await aUser(t);
    const item = rows(list)[0]!;

    await t.http().post('/api/shopping-lists/generate').set(as(other)).send({ planId: plan.id }).expect(403);
    await t.http().get(`/api/shopping-lists?planId=${plan.id}`).set(as(other)).expect(403);
    await t.http().get(`/api/shopping-lists/${list.id}`).set(as(other)).expect(403);
    await t.http().patch(`/api/shopping-lists/${list.id}/items/${item.id}`).set(as(other)).send({ checked: true }).expect(403);
    await t.http().delete(`/api/shopping-lists/${list.id}`).set(as(other)).expect(403);

    expect(await t.prisma.shoppingList.count()).toBe(1);
  });

  /** A small generator of the same numbers for the same seed. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let x = state;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  describe('any sequence of ticks, unticks and edits on two lists', () => {
    /** Two days of three eggs each, a list for each day, and eggs in pieces, in grams or in both. */
    async function setUp(random: () => number): Promise<{ first: ShoppingList; second: ShoppingList; initial: string[]; total: number }> {
      await t.prisma.shoppingList.deleteMany({});
      await t.prisma.inventoryItem.deleteMany({ where: { profileId: profile.id } });
      const kind = Math.floor(random() * 3);
      if (kind !== 1) await stock('large-egg', 1 + Math.floor(random() * 8), 'piece', random() < 0.5 ? '2026-02-01' : null);
      if (kind !== 0) await stock('large-egg', 55 * (1 + Math.floor(random() * 6)), 'g', random() < 0.5 ? '2026-01-20' : null);
      const initial = await pantry('large-egg');
      const egg = await ingredient('large-egg');
      const total = pantryStock(await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id } }), egg).quantity;
      return { first: await listFor(0), second: await listFor(1), initial, total };
    }

    /** The eggs in the pantry and what the egg rows of the lists say they did to it, in grams. */
    async function books(): Promise<{ inPantry: number; ledgers: number; negative: boolean }> {
      const egg = await ingredient('large-egg');
      const held = await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id, ingredientId: egg.id } });
      const items = await t.prisma.shoppingListItem.findMany({ where: { ingredientId: egg.id } });
      return {
        inPantry: pantryStock(held, egg).quantity,
        ledgers: items.reduce((sum, item) => sum + netEffect(readMoves(item.pantryMoves), egg), 0),
        negative: held.some((row) => row.quantity < 0),
      };
    }

    beforeEach(async () => {
      await menu(0, [EGGS_ON_TOAST, TOFU_BOWL, CHICKEN_RICE]);
      await menu(1, [EGGS_ON_TOAST, TOFU_BOWL, CHICKEN_RICE]);
    });

    it('keeps the pantry at what it was plus what the rows say they did', async () => {
      for (let seed = 1; seed <= 12; seed += 1) {
        const random = seeded(seed);
        const { first, second, total } = await setUp(random);
        // Rows that arrived ticked have already taken their eggs.
        const start = await books();
        expect(start.inPantry, `seed ${seed} at the start`).toBeCloseTo(total + start.ledgers, 3);

        for (let step = 0; step < 10; step += 1) {
          const list = random() < 0.5 ? first : second;
          const action = random();
          const patch =
            action < 0.3 ? { checked: true } : action < 0.55 ? { checked: false } : action < 0.9 ? { purchasedQuantity: Math.floor(random() * 12) } : { purchasedQuantity: null };
          await lists.updateItem(user.id, 'en', list.id, rowOf(list, 'Large egg').id, patch);

          const now = await books();
          expect(now.negative, `seed ${seed}, step ${step}`).toBe(false);
          expect(now.inPantry, `seed ${seed}, step ${step}: ${JSON.stringify(patch)}`).toBeCloseTo(total + now.ledgers, 3);
        }
      }
    });

    it('ends with the pantry it began with, row for row, once every row is unticked', async () => {
      for (let seed = 101; seed <= 112; seed += 1) {
        const random = seeded(seed);
        const { first, second, initial } = await setUp(random);

        for (let step = 0; step < 8; step += 1) {
          const list = random() < 0.5 ? first : second;
          // Ticks and unticks only: nothing is bought beyond the need.
          await lists.updateItem(user.id, 'en', list.id, rowOf(list, 'Large egg').id, { checked: random() < 0.6 });
        }
        for (const list of [first, second]) {
          await lists.updateItem(user.id, 'en', list.id, rowOf(list, 'Large egg').id, { checked: false });
        }

        expect(await pantry('large-egg'), `seed ${seed}`).toEqual(initial);
        expect((await books()).ledgers).toBe(0);
      }
    });

    it('returns to the pantry it began with when both lists are removed before their days, having only been ticked', async () => {
      for (let seed = 201; seed <= 208; seed += 1) {
        const random = seeded(seed);
        const { first, second, initial } = await setUp(random);
        for (let step = 0; step < 6; step += 1) {
          const list = random() < 0.5 ? first : second;
          await lists.updateItem(user.id, 'en', list.id, rowOf(list, 'Large egg').id, { checked: random() < 0.6 });
        }
        // What a ticked row holds beyond its claim was bought: that part is new.
        const egg = await ingredient('large-egg');
        const bought = (await t.prisma.shoppingListItem.findMany({ where: { ingredientId: egg.id } })).reduce(
          (sum, item) => sum + (item.checked ? Math.max(0, (item.purchasedQuantity ?? 0) - item.alreadyHaveQuantity) : 0),
          0,
        );

        await lists.remove(user.id, first.id, BEFORE);
        await lists.remove(user.id, second.id, BEFORE);

        const end = await books();
        const began = pantryStock(
          initial.map((text) => ({ quantity: Number(text.split(' ')[0]), unit: text.split(' ')[1] as 'g' | 'piece', bestBefore: null })),
          egg,
        ).quantity;
        expect(end.inPantry, `seed ${seed}`).toBeCloseTo(began + bought * 55, 3);
      }
    });
  });
});
