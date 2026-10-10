// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MAX_LISTS_PER_PLAN,
  type DisplayUnit,
  type GenerateShoppingListRequest,
  type Locale,
  type ShoppingList,
  type Unit,
  type UpdateShoppingItemRequest,
} from '@diet-app/shared';
import {
  aggregateShoppingList,
  convertUnit,
  editRow,
  groupByAisle,
  intendedPantryEffect,
  isCounted,
  pantryEffectOnRemoval,
  pantryStock,
  quantityToClaim,
  shareAhead,
  toBuyQuantity,
  UnitConversionError,
  type PlanIngredientLine,
  type ShoppingIngredient,
} from '../engine/index.js';
import { assertWithinCeiling, lockPantry, readMoves, settlePantry } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pickIngredient } from '../recipes/recipes.service.js';

/** A list touches many pantry rows in one transaction; the default five seconds is too tight on a slow disk. */
const TRANSACTION = { timeout: 30_000, maxWait: 10_000 } as const;

type Tx = Prisma.TransactionClient;

/** An ingredient row as the shopping code reads it. */
type IngredientRow = ShoppingIngredient & { translations: { locale: string; name: string }[] };

interface StoredItem {
  id: string;
  ingredientId: string;
  name: string;
  category: string;
  totalQuantity: number;
  unit: Unit;
  alreadyHaveQuantity: number;
  purchasedQuantity: number | null;
  pantryMoves: Prisma.JsonValue;
  pantryBestBefore: Date | null;
  estimatedCalories: number;
  checked: boolean;
}

interface StoredList {
  id: string;
  planId: string;
  fromDate: Date;
  toDate: Date;
  createdAt: Date;
  items: StoredItem[];
}

/**
 * Builds and maintains consolidated shopping lists from meal plans.
 *
 * A row and the pantry: see `ShoppingListItem` in the contract for what a row
 * means, `engine/shopping.ts` for the rules and `engine/pantry.ts` for how the
 * pantry rows change. This service adds the order of things:
 *
 *  - one row is changed under a lock on that row, so two edits of it take
 *    turns and the second sees what the first did;
 *  - the pantry rows of one ingredient change under `lockPantry`;
 *  - lists of one profile are made one at a time, so that two of them cannot
 *    both count on the same stock.
 */
@Injectable()
export class ShoppingListsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregate every ingredient across the selected plan range into a list.
   *
   * A day belongs to one list: lists of the plan whose dates overlap the new
   * one are replaced by it. What was obtained for them goes into the pantry
   * first, so the new list finds it there and asks only for what is missing.
   */
  async generate(userId: string, locale: Locale, req: GenerateShoppingListRequest): Promise<ShoppingList> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: req.planId },
      include: { profile: true, days: { orderBy: { date: 'asc' }, select: { date: true } } },
    });
    if (!plan?.profile) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    const profileId = plan.profile.id;

    const first = plan.days[0]?.date ?? plan.startDate;
    const last = plan.days.at(-1)?.date ?? plan.startDate;
    const from = req.fromDate ? new Date(req.fromDate) : first;
    const to = req.toDate ? new Date(req.toDate) : last;
    if (from > to || from < first || to > last) {
      throw new BadRequestException({
        error: 'SHOPPING_RANGE_OUTSIDE_PLAN',
        message: `The dates must lie within the plan: ${isoDate(first)} to ${isoDate(last)}.`,
      });
    }

    const listId = await this.prisma.$transaction(async (tx) => {
      // One list of a profile at a time: each counts on what the others left.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shopping:${profileId}`}, 0))`);
      // The menu must not change between reading it and writing the list.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "id" = ${plan.id} FOR UPDATE`);

      const overlapping = await tx.shoppingList.findMany({
        where: { planId: plan.id, fromDate: { lte: to }, toDate: { gte: from } },
        select: { id: true },
      });
      await releaseLists(tx, profileId, overlapping.map((list) => list.id), () => 1);
      await tx.shoppingList.deleteMany({ where: { id: { in: overlapping.map((list) => list.id) } } });

      if ((await tx.shoppingList.count({ where: { planId: plan.id } })) >= MAX_LISTS_PER_PLAN) {
        throw new ConflictException({
          error: 'SHOPPING_LIST_LIMIT',
          message: `A plan has at most ${MAX_LISTS_PER_PLAN} shopping lists. Delete one first.`,
        });
      }

      const needs = await planNeeds(tx, plan.id, from, to);
      const items = needs.groups.flatMap((group) => group.items);
      const claimed = await openClaims(tx, profileId, needs.ingredients);

      const list = await tx.shoppingList.create({ data: { planId: plan.id, fromDate: from, toDate: to } });
      // In the order every writer takes the pantry locks in.
      for (const item of [...items].sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1))) {
        const ingredient = needs.ingredients.get(item.ingredientId)!;
        await lockPantry(tx, profileId, ingredient.id);
        const rows = await tx.inventoryItem.findMany({
          where: { profileId, ingredientId: ingredient.id },
          select: { unit: true, quantity: true, bestBefore: true },
        });
        const stock = pantryStock(rows, ingredient);
        const free = stock.quantity - (claimed.get(ingredient.id) ?? 0);
        const have = quantityToClaim(convertUnit(free, ingredient.canonicalUnit, item.unit, ingredient), item.unit, item.totalQuantity);
        // A need the pantry covers in full needs no shopping: the row arrives
        // ticked, and what it counts on leaves the pantry now.
        const covered = have > 0 && have >= item.totalQuantity;
        const moves = covered
          ? await settlePantry(tx, profileId, ingredient, [], -convertUnit(have, item.unit, ingredient.canonicalUnit, ingredient))
          : [];
        await tx.shoppingListItem.create({
          data: {
            listId: list.id,
            ingredientId: item.ingredientId,
            name: item.name,
            category: item.category,
            totalQuantity: item.totalQuantity,
            unit: item.unit,
            alreadyHaveQuantity: have,
            // One number for the user to raise as they shop: it starts at what is at home.
            purchasedQuantity: have > 0 ? have : null,
            checked: covered,
            pantryMoves: moves as unknown as Prisma.InputJsonValue,
            pantryBestBefore: have > 0 ? stock.bestBefore : null,
            estimatedCalories: item.estimatedCalories,
          },
        });
      }
      return list.id;
    }, TRANSACTION);

    return this.get(userId, locale, listId);
  }

  /** Every list belonging to a plan the user owns, newest first. */
  async listForPlan(userId: string, locale: Locale, planId: string): Promise<ShoppingList[]> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true },
    });
    if (!plan?.profile) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    const rows = await this.prisma.shoppingList.findMany({
      where: { planId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return this.toDtos(rows, locale);
  }

  /**
   * Delete a list the user owns. What was obtained for the days still ahead
   * goes into the pantry, because it is in the kitchen; what was obtained for
   * days already past is taken as eaten. A list that is over is therefore
   * removed without a trace, and one deleted before cooking gives everything
   * back.
   */
  async remove(userId: string, listId: string, today: Date = new Date()): Promise<void> {
    const list = await this.loadOwned(userId, listId);
    await this.prisma.$transaction(async (tx) => {
      await releaseLists(tx, list.plan.profile.id, [listId], (dates) => shareAhead(dates.fromDate, dates.toDate, today));
      await tx.shoppingList.deleteMany({ where: { id: listId } });
    }, TRANSACTION);
  }

  async get(userId: string, locale: Locale, listId: string): Promise<ShoppingList> {
    const list = await this.loadOwned(userId, listId);
    return (await this.toDtos([list], locale))[0]!;
  }

  /** Update an item's purchased quantity or checked state: see `editRow`. */
  async updateItem(
    userId: string,
    locale: Locale,
    listId: string,
    itemId: string,
    patch: UpdateShoppingItemRequest,
  ): Promise<ShoppingList> {
    const list = await this.loadOwned(userId, listId);
    const profileId = list.plan.profile.id;

    await this.prisma.$transaction(async (tx) => {
      // Read under a lock, so that a second edit of the row waits for this one
      // and works from what it left.
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ShoppingListItem" WHERE "id" = ${itemId} AND "listId" = ${listId} FOR UPDATE`,
      );
      if (locked.length === 0) {
        throw new NotFoundException({ error: 'ITEM_NOT_FOUND', message: 'Shopping list item not found.' });
      }
      const item = await tx.shoppingListItem.findUniqueOrThrow({ where: { id: itemId } });
      const next = editRow(item, patch);
      if (next.purchasedQuantity !== null) assertWithinCeiling(next.purchasedQuantity, item.unit);

      const moves = await settleRow(tx, profileId, item, intendedPantryEffect({ ...item, ...next }));
      await tx.shoppingListItem.update({
        where: { id: itemId },
        data: { ...next, ...(moves ? { pantryMoves: moves as unknown as Prisma.InputJsonValue } : {}) },
      });
    }, TRANSACTION);
    return this.get(userId, locale, listId);
  }

  private async loadOwned(userId: string, listId: string) {
    const list = await this.prisma.shoppingList.findUnique({
      where: { id: listId },
      include: { items: true, plan: { include: { profile: true } } },
    });
    if (!list?.plan?.profile) throw new NotFoundException({ error: 'LIST_NOT_FOUND', message: 'Shopping list not found.' });
    if (list.plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'List belongs to another user.' });
    }
    return list;
  }

  /**
   * Lists of one plan as the contract shows them. Names and the name of a
   * piece are read from the ingredient as it is now, so a list follows the
   * user's language and a corrected name; a row whose ingredient is gone keeps
   * the name it was made with.
   */
  private async toDtos(lists: StoredList[], locale: Locale): Promise<ShoppingList[]> {
    if (lists.length === 0) return [];
    const ids = [...new Set(lists.flatMap((list) => list.items.map((item) => item.ingredientId)))];
    const ingredients = await loadIngredients(this.prisma, ids);

    return lists.map((list) => {
      const items = list.items.map((item) => {
        const ingredient = ingredients.get(item.ingredientId);
        // A row in pieces is called what its ingredient calls a piece.
        const displayUnit: DisplayUnit = item.unit === 'piece' && ingredient && isCounted(ingredient) ? ingredient.displayUnit : item.unit;
        return {
          id: item.id,
          ingredientId: item.ingredientId,
          name: ingredient ? pickIngredient(locale, ingredient.translations, ingredient.name) : item.name,
          category: item.category as ShoppingList['groups'][number]['category'],
          totalQuantity: item.totalQuantity,
          unit: item.unit,
          displayUnit,
          alreadyHaveQuantity: item.alreadyHaveQuantity,
          toBuyQuantity: toBuyQuantity(item.totalQuantity, item.alreadyHaveQuantity),
          purchasedQuantity: item.purchasedQuantity,
          pantryBestBefore: item.pantryBestBefore ? isoDate(item.pantryBestBefore) : null,
          estimatedCalories: item.estimatedCalories,
          checked: item.checked,
        };
      });
      return {
        id: list.id,
        planId: list.planId,
        fromDate: isoDate(list.fromDate),
        toDate: isoDate(list.toDate),
        groups: groupByAisle(items),
        totalEstimatedCalories: Math.round(list.items.reduce((sum, item) => sum + item.estimatedCalories, 0)),
        createdAt: list.createdAt.toISOString(),
      };
    });
  }
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

type Reader = Pick<Tx, 'ingredient' | 'mealPlanDay'>;

async function loadIngredients(db: Pick<Tx, 'ingredient'>, ids: string[]): Promise<Map<string, IngredientRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.ingredient.findMany({
    where: { id: { in: ids } },
    include: { translations: { select: { locale: true, name: true } } },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        ...row,
        allergens: row.allergens as ShoppingIngredient['allergens'],
        dietCompatibility: row.dietCompatibility as ShoppingIngredient['dietCompatibility'],
      },
    ]),
  );
}

/** Every ingredient line the plan's menu has between two dates, as the menu is now. */
async function planLines(db: Pick<Tx, 'mealPlanDay'>, planId: string, from: Date, to: Date): Promise<PlanIngredientLine[]> {
  const days = await db.mealPlanDay.findMany({
    where: { planId, date: { gte: from, lte: to } },
    select: {
      meals: {
        select: {
          source: true,
          servings: true,
          quantityScale: true,
          recipe: { select: { servings: true, ingredients: { select: { ingredientId: true, quantity: true, unit: true } } } },
        },
      },
    },
  });
  const lines: PlanIngredientLine[] = [];
  for (const day of days) {
    for (const meal of day.meals) {
      // A custom meal has no ingredients. Whether a meal was eaten changes
      // nothing: a list says what the days need, not what is left of them.
      if (meal.source === 'USER_CUSTOM' || !meal.recipe) continue;
      for (const line of meal.recipe.ingredients) {
        lines.push({
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          unit: line.unit,
          recipeServings: meal.recipe.servings,
          // Effective amount folds the rebalancer multiplier into servings.
          plannedServings: meal.servings * meal.quantityScale,
        });
      }
    }
  }
  return lines;
}

/** What the plan's menu needs between two dates, by aisle, with the ingredients it names. */
async function planNeeds(db: Reader, planId: string, from: Date, to: Date) {
  const lines = await planLines(db, planId, from, to);
  const ingredients = await loadIngredients(db, [...new Set(lines.map((line) => line.ingredientId))]);
  return { groups: aggregateShoppingList(lines, ingredients), ingredients };
}

/**
 * What the profile's lists count on from the pantry without having taken it
 * yet: the claims of rows that are not ticked, per ingredient, in its
 * canonical unit. A new list sees the stock less these.
 */
async function openClaims(tx: Tx, profileId: string, ingredients: ReadonlyMap<string, ShoppingIngredient>): Promise<Map<string, number>> {
  const rows = await tx.shoppingListItem.findMany({
    where: {
      checked: false,
      alreadyHaveQuantity: { gt: 0 },
      ingredientId: { in: [...ingredients.keys()] },
      list: { plan: { profileId } },
    },
    select: { ingredientId: true, unit: true, alreadyHaveQuantity: true },
  });
  const claims = new Map<string, number>();
  for (const row of rows) {
    const ingredient = ingredients.get(row.ingredientId)!;
    try {
      const amount = convertUnit(row.alreadyHaveQuantity, row.unit, ingredient.canonicalUnit, ingredient);
      claims.set(row.ingredientId, (claims.get(row.ingredientId) ?? 0) + amount);
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
    }
  }
  return claims;
}

/**
 * Bring a row's effect on the pantry to `effect` (in the row's unit) and
 * return its ledger afterwards. Null when the pantry cannot be reached for
 * the row: its ingredient is gone, or can no longer be converted from the
 * row's unit. The row then keeps the ledger it has.
 */
async function settleRow(tx: Tx, profileId: string, item: StoredItem, effect: number) {
  const ingredient = await tx.ingredient.findUnique({ where: { id: item.ingredientId } });
  if (!ingredient) return null;
  let target: number;
  try {
    target = convertUnit(effect, item.unit, ingredient.canonicalUnit, ingredient);
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return null;
  }
  await lockPantry(tx, profileId, ingredient.id);
  return settlePantry(tx, profileId, ingredient, readMoves(item.pantryMoves), target);
}

/**
 * Settle the rows of lists that are about to be removed: for each, `share`
 * says how much of what its rows hold for the plan is still in the kitchen
 * and goes into the pantry (see `pantryEffectOnRemoval`). The lists
 * themselves are left for the caller to delete, in the same transaction.
 */
export async function releaseLists(
  tx: Tx,
  profileId: string,
  listIds: readonly string[],
  share: (list: { fromDate: Date; toDate: Date }) => number,
): Promise<void> {
  if (listIds.length === 0) return;
  // Rows first, then the pantry: the order every writer takes its locks in.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShoppingListItem" WHERE "listId" IN (${Prisma.join(listIds)}) ORDER BY "id" FOR UPDATE`);
  const lists = await tx.shoppingList.findMany({ where: { id: { in: [...listIds] } }, include: { items: true } });
  const rows = lists.flatMap((list) => list.items.map((item) => ({ item, share: share(list) })));
  rows.sort((a, b) => (a.item.ingredientId === b.item.ingredientId ? 0 : a.item.ingredientId < b.item.ingredientId ? -1 : 1));
  for (const { item, share: part } of rows) {
    await settleRow(tx, profileId, item, pantryEffectOnRemoval(item, part));
  }
}

/**
 * Settle every list of a plan that is about to be deleted, by the rule of
 * `ShoppingListsService.remove`. The plan's deletion then removes the lists.
 */
export async function releasePlanLists(tx: Tx, planId: string, profileId: string, today: Date = new Date()): Promise<void> {
  const lists = await tx.shoppingList.findMany({ where: { planId }, select: { id: true } });
  await releaseLists(tx, profileId, lists.map((list) => list.id), (dates) => shareAhead(dates.fromDate, dates.toDate, today));
}
