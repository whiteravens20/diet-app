// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MAX_LISTS_PER_PLAN,
  PlanOptions,
  type DisplayUnit,
  type GenerateShoppingListRequest,
  type Locale,
  type ShoppingList,
  type ShoppingListItem,
  type Unit,
  type UpdateShoppingItemRequest,
} from '@diet-app/shared';
import {
  aggregateShoppingList,
  byPantry,
  convertUnit,
  editRow,
  energyOf,
  freshPurchases,
  groupByAisle,
  isCounted,
  keepDaysOf,
  looseDay,
  packsToBuy,
  pantryEffects,
  pantryStock,
  quantityToClaim,
  shareAhead,
  toBuyQuantity,
  toCanonical,
  UnitConversionError,
  withAtHome,
  type AggregatedItem,
  type ConvertibleIngredient,
  type PantryMove,
  type PlanIngredientLine,
  type ShoppingIngredient,
  type ShoppingRowState,
} from '../engine/index.js';
import { levelOf } from '../engine/waste-levels.js';
import {
  assertWithinCeiling,
  lockPantries,
  lockPantry,
  mayTakeOf,
  readBorrowed,
  readMoves,
  settlePantry,
  type Borrowed,
} from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pickIngredient } from '../recipes/recipes.service.js';
import { plateOfMeal, plateShare, restsOf } from '../meal-plans/plan-days.js';
import { toppingIngredientsOf } from '../meal-plans/toppings-store.js';
import { freezerOf } from '../meal-plans/generation-report.js';
import { followKitchen } from '../meal-plans/plan-write.js';
import { pieceFactorOf, pieceUsesOf } from '../meal-plans/whole-pieces-store.js';

/** A list touches many pantry rows in one transaction; the default five seconds is too tight on a slow disk. */
export const TRANSACTION = { timeout: 30_000, maxWait: 10_000 } as const;

export type Tx = Prisma.TransactionClient;

/** An ingredient row as the shopping code reads it. */
export type IngredientRow = ShoppingIngredient & {
  translations: { locale: string; name: string }[];
  /** Whether an opened pack of it keeps only days, and its tags (`pantry` and `cured` for meat or fish that keeps closed). */
  perishable: boolean;
  tags: string[];
};

export interface StoredItem {
  id: string;
  ingredientId: string;
  name: string;
  category: string;
  totalQuantity: number;
  unit: Unit;
  alreadyHaveQuantity: number;
  purchasedQuantity: number | null;
  /** The day what was bought for the row was bought by weight (`ShoppingListItem.boughtLooseOn`). */
  boughtLooseOn: Date | null;
  pantryMoves: Prisma.JsonValue;
  /** What of `alreadyHaveQuantity` was counted in the pantries of other profiles of a household list (`Borrowed`). */
  borrowed: Prisma.JsonValue;
  pantryBestBefore: Date | null;
  estimatedCalories: number;
  checked: boolean;
}

export interface StoredList {
  id: string;
  planId: string;
  householdId: string | null;
  fromDate: Date;
  toDate: Date;
  createdAt: Date;
  items: StoredItem[];
}

/** The order of a household list's parts, wherever they are named: by the profile they are for. */
export const PART_ORDER = [{ plan: { profile: { name: 'asc' } } }, { id: 'asc' }] as const;

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
  async generate(
    userId: string,
    locale: Locale,
    req: GenerateShoppingListRequest,
  ): Promise<ShoppingList> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: req.planId },
      include: { profile: true, days: { orderBy: { date: 'asc' }, select: { date: true } } },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
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
      const made = await makeList(tx, { id: plan.id, profileId }, from, to);
      await settleHouseholds(tx, made.leftHouseholds);
      return made.listId;
    }, TRANSACTION);

    return this.get(userId, locale, listId);
  }

  /** Every list belonging to a plan the user owns, newest first. */
  async listForPlan(userId: string, locale: Locale, planId: string): Promise<ShoppingList[]> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const rows = await this.prisma.shoppingList.findMany({
      where: { planId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return this.toDtos(rows, locale, plan.profileId);
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
      await releaseLists(tx, list.plan.profile.id, [listId], (dates) =>
        shareAhead(dates.fromDate, dates.toDate, today),
      );
      await tx.shoppingList.deleteMany({ where: { id: listId } });
      await settleHouseholds(tx, list.householdId ? [list.householdId] : []);
    }, TRANSACTION);
  }

  async get(userId: string, locale: Locale, listId: string): Promise<ShoppingList> {
    const list = await this.loadOwned(userId, listId);
    return (await this.toDtos([list], locale, list.plan.profileId))[0]!;
  }

  /** Update an item's purchased quantity or checked state: see `editRow`. */
  async updateItem(
    userId: string,
    locale: Locale,
    listId: string,
    itemId: string,
    patch: UpdateShoppingItemRequest,
    /** The client's day: what is said to be bought by weight is bought that day. */
    clientToday: string | null = null,
  ): Promise<ShoppingList> {
    const list = await this.loadOwned(userId, listId);
    const profileId = list.plan.profile.id;
    const today = new Date(`${clientToday ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);

    await this.prisma.$transaction(async (tx) => {
      // Read under a lock, so that a second edit of the row waits for this one
      // and works from what it left.
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ShoppingListItem" WHERE "id" = ${itemId} AND "listId" = ${listId} FOR UPDATE`,
      );
      if (locked.length === 0) {
        throw new NotFoundException({
          error: 'ITEM_NOT_FOUND',
          message: 'Shopping list item not found.',
        });
      }
      const item = await tx.shoppingListItem.findUniqueOrThrow({ where: { id: itemId } });
      // What is at home is said first: the quantity and the tick of the same request are read against it.
      const { alreadyHaveQuantity, boughtLoose, ...edit } = patch;
      const atHome =
        alreadyHaveQuantity === undefined ? null : withAtHome(item, alreadyHaveQuantity);
      const edited = { ...atHome, ...editRow({ ...item, ...atHome }, edit) };
      const food = await tx.ingredient.findUnique({ where: { id: item.ingredientId } });
      const next = {
        ...edited,
        boughtLooseOn: looseDay(
          item.boughtLooseOn,
          boughtLoose,
          { ...item, ...edited },
          isFreshMeatInPacks(food),
          today,
        ),
        // The date was that of what the pantry held for the row: with nothing at home there is none.
        ...(atHome?.alreadyHaveQuantity === 0 ? { pantryBestBefore: null } : {}),
      };
      if (next.purchasedQuantity !== null) assertWithinCeiling(next.purchasedQuantity, item.unit);

      // What is said to be at home is the row's own: what it counted in other pantries goes back to them.
      const borrowed = readBorrowed(item.borrowed);
      const ledgers = await settleRow(
        tx,
        { profileId, planId: list.planId },
        item,
        { ...item, ...next },
        atHome ? { borrowed: [], dropped: borrowed } : { borrowed },
      );
      await tx.shoppingListItem.update({
        where: { id: itemId },
        data: { ...next, ...stored(ledgers) },
      });
      // What is bought by weight is the plan's to eat before any pack: its rests and the days they move follow at once.
      if (item.boughtLooseOn !== null || next.boughtLooseOn !== null)
        await followKitchen(tx, list.planId, isoDate(today));
    }, TRANSACTION);
    return this.get(userId, locale, listId);
  }

  private async loadOwned(userId: string, listId: string) {
    const list = await this.prisma.shoppingList.findUnique({
      where: { id: listId },
      include: { items: true, plan: { include: { profile: true } } },
    });
    if (!list?.plan?.profile || list.plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'LIST_NOT_FOUND', message: 'Shopping list not found.' });
    return list;
  }

  /** Lists of one plan of `profileId` as the contract shows them: see `itemDto` for their rows. */
  private async toDtos(
    lists: StoredList[],
    locale: Locale,
    profileId: string,
  ): Promise<ShoppingList[]> {
    if (lists.length === 0) return [];
    const ids = [...new Set(lists.flatMap((list) => list.items.map((item) => item.ingredientId)))];
    const ingredients = await loadIngredients(this.prisma, ids);
    const from = new Date(Math.min(...lists.map((list) => list.fromDate.getTime())));
    const to = new Date(Math.max(...lists.map((list) => list.toDate.getTime())));
    const lines = await planLines(this.prisma, lists[0]!.planId, from, to);
    const households = await householdsOf(this.prisma, lists);
    const freezes = await freezesOf(this.prisma, [lists[0]!.planId]);
    const frozen = await frozenKeptOf(this.prisma, profileId, lists[0]!.planId, ingredients);
    const pantries = await pantriesOfRows(
      this.prisma,
      profileId,
      lists.flatMap((list) => list.items),
    );

    return lists.map((list) => {
      const items = list.items.map((item) => {
        const ingredient = ingredients.get(item.ingredientId);
        return itemDto(
          item,
          ingredient,
          locale,
          freshOf(item, ingredient, lines, list, freezes),
          frozen.get(item.ingredientId),
          pantries.get(item.id),
        );
      });
      return {
        id: list.id,
        planId: list.planId,
        fromDate: isoDate(list.fromDate),
        toDate: isoDate(list.toDate),
        groups: groupByAisle(items, locale).map((group) => ({
          ...group,
          estimatedCalories: energyOf(group.items),
        })),
        totalEstimatedCalories: energyOf(list.items),
        stale: isStale(list, lines, ingredients),
        household: (list.householdId && households.get(list.householdId)) || null,
        createdAt: list.createdAt.toISOString(),
      };
    });
  }
}

/**
 * A row as the contract shows it. Its name and the name of a piece are read
 * from the ingredient as it is now, so a list follows the user's language and
 * a corrected name; a row whose ingredient is gone keeps the name it was made
 * with.
 */
export function itemDto(
  item: StoredItem,
  ingredient: IngredientRow | undefined,
  locale: Locale,
  fresh: Fresh | null = null,
  /** What the freezer holds of the food that the row does not count, in the food's canonical unit (`frozenKeptOf`). */
  frozen = 0,
  /** Whose pantry holds what is at home, where more than the row's own counts (`ShoppingListItem.pantries`). */
  pantries: ShoppingListItem['pantries'] = [],
): ShoppingListItem {
  // A row in pieces is called what its ingredient calls a piece.
  const displayUnit: DisplayUnit =
    item.unit === 'piece' && ingredient && isCounted(ingredient)
      ? ingredient.displayUnit
      : item.unit;
  const toBuy = toBuyQuantity(item.totalQuantity, item.alreadyHaveQuantity);
  return {
    id: item.id,
    ingredientId: item.ingredientId,
    name: ingredient ? pickIngredient(locale, ingredient.translations, ingredient.name) : item.name,
    category: item.category as ShoppingListItem['category'],
    totalQuantity: item.totalQuantity,
    unit: item.unit,
    displayUnit,
    gramsPerPiece:
      item.unit === 'piece' && ingredient?.gramsPerPiece ? ingredient.gramsPerPiece : null,
    alreadyHaveQuantity: item.alreadyHaveQuantity,
    pantries,
    toBuyQuantity: toBuy,
    purchasedQuantity: item.purchasedQuantity,
    boughtLooseOn: item.boughtLooseOn ? isoDate(item.boughtLooseOn) : null,
    byWeight: isFreshMeatInPacks(ingredient),
    frozenKept: ingredient && frozen > 0 ? inRowUnit(frozen, item.unit, ingredient) : 0,
    pantryBestBefore: item.pantryBestBefore ? isoDate(item.pantryBestBefore) : null,
    estimatedCalories: item.estimatedCalories,
    // What was bought by weight leaves no packs to buy: what the row still lacks is said in its own unit.
    packs:
      ingredient && !item.boughtLooseOn
        ? packsToBuy(toBuy, { unit: item.unit, displayUnit }, ingredient, fresh?.count)
        : null,
    buyLater: item.boughtLooseOn ? [] : (fresh?.later ?? []),
    checked: item.checked,
  };
}

/**
 * Of the rows of a list of `profileId` that count on the pantries of other profiles of a household list, whose pantry
 * holds what is at home (`ShoppingListItem.pantries`), by row: its own first, then those it counted on. A row that
 * counts on its own pantry alone is not named.
 */
async function pantriesOfRows(
  db: Pick<Tx, 'profile'>,
  profileId: string,
  items: readonly StoredItem[],
): Promise<Map<string, ShoppingListItem['pantries']>> {
  const lent = items
    .map((item) => ({ item, borrowed: readBorrowed(item.borrowed) }))
    .filter(({ borrowed }) => borrowed.length > 0);
  if (lent.length === 0) return new Map();
  const names = await profileNames(db, [
    profileId,
    ...lent.flatMap(({ borrowed }) => borrowed.map((one) => one.profileId)),
  ]);
  return new Map(
    lent.map(({ item, borrowed }) => [
      item.id,
      withNames(byPantry([{ profileId, atHome: item.alreadyHaveQuantity, borrowed }]), names),
    ]),
  );
}

/** The names of profiles, by id. */
export async function profileNames(
  db: Pick<Tx, 'profile'>,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const profiles = await db.profile.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(profiles.map((profile) => [profile.id, profile.name]));
}

/** Amounts by profile (`byPantry`) as the contract names them. */
export function withNames(
  held: readonly { profileId: string; quantity: number }[],
  names: ReadonlyMap<string, string>,
): ShoppingListItem['pantries'] {
  return held.map((one) => ({ ...one, profile: names.get(one.profileId) ?? '' }));
}

/** Tags of a meat or fish that keeps closed far longer than opened: tinned, or smoked and cured. */
const KEEPS_CLOSED = new Set(['pantry', 'cured']);

/**
 * Fresh meat or fish in packs, which keeps from its purchase about as long as from its opening: what a list buys on
 * the days its plan needs it (`freshOf`), and what can be bought by weight instead (`ShoppingListItem.boughtLooseOn`).
 */
export function isFreshMeatInPacks(
  ingredient:
    Pick<IngredientRow, 'perishable' | 'packSize' | 'category' | 'tags'> | null | undefined,
): boolean {
  return (
    !!ingredient?.perishable &&
    !!ingredient.packSize &&
    ingredient.packSize > 0 &&
    (ingredient.category === 'meat' || ingredient.category === 'fish') &&
    !ingredient.tags.some((tag) => KEEPS_CLOSED.has(tag))
  );
}
const DAY = 86_400_000;

/**
 * Whether the plans of a kitchen put what they do not eat fresh of meat and fish in the freezer: one of them wastes
 * less or nothing (`WasteLevel.freezes`). Its packs are then counted with the freezer, as the plan counts them.
 */
export async function freezesOf(
  db: Pick<Tx, 'mealPlan'>,
  planIds: readonly string[],
): Promise<boolean> {
  const plans = await db.mealPlan.findMany({
    where: { id: { in: [...planIds] } },
    select: { options: true },
  });
  return plans.some((plan) => levelOf(PlanOptions.parse(plan.options))?.freezes !== undefined);
}

/** Of a row of fresh meat or fish, its packs as the list's days take them, and those to buy later than its first day. */
export interface Fresh {
  count: number;
  later: { packs: number; from: string }[];
}

/**
 * Of a row of fresh meat or fish, which keeps from its purchase about as long
 * as from its opening: its packs as the plan counts them over the list's days
 * (`freshPurchases`), what the row counts as at home eaten first, and those of
 * them to buy later than the list's first day, by the day from which they
 * are. Null for any other row: closed, it keeps longer than its days after
 * opening say. `lines` may hold other ingredients and other days. Of a plan
 * that wastes less or nothing (`freezes`), what a pack holds beyond the days it keeps
 * goes in the freezer and a later need takes it from there before a new pack
 * is bought, as the plan counts it.
 */
export function freshOf(
  item: Pick<StoredItem, 'ingredientId' | 'unit' | 'totalQuantity' | 'alreadyHaveQuantity'>,
  ingredient: IngredientRow | undefined,
  lines: readonly DatedLine[],
  list: { fromDate: Date; toDate: Date },
  freezes = false,
): Fresh | null {
  if (!ingredient || !isFreshMeatInPacks(ingredient)) return null;
  const days = Math.round((list.toDate.getTime() - list.fromDate.getTime()) / DAY) + 1;
  const byDay = Array.from({ length: Math.max(0, days) }, () => 0);
  try {
    for (const line of lines) {
      if (line.ingredientId !== ingredient.id) continue;
      const day = Math.round((line.date.getTime() - list.fromDate.getTime()) / DAY);
      if (day < 0 || day >= byDay.length) continue;
      const scale = line.recipeServings > 0 ? line.plannedServings / line.recipeServings : 1;
      byDay[day]! += toCanonical(line.quantity * scale, line.unit, ingredient);
    }
    const held = toCanonical(item.alreadyHaveQuantity, item.unit, ingredient);
    const { count, later } = freshPurchases(
      byDay,
      {
        size: ingredient.packSize!,
        keepDays: keepDaysOf(ingredient),
        ...(freezes ? { freezes: true } : {}),
      },
      held,
    );
    if (count === 0) return null;
    return {
      count,
      later: later.map(({ day, packs }) => ({
        packs,
        from: isoDate(new Date(list.fromDate.getTime() + day * DAY)),
      })),
    };
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return null;
  }
}

/** The household lists that lists are parts of, as each part names its own: two parts at least, or none. */
async function householdsOf(
  db: Pick<Tx, 'householdList'>,
  lists: readonly StoredList[],
): Promise<Map<string, NonNullable<ShoppingList['household']>>> {
  const ids = [...new Set(lists.flatMap((list) => (list.householdId ? [list.householdId] : [])))];
  if (ids.length === 0) return new Map();
  const rows = await db.householdList.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      parts: {
        orderBy: [...PART_ORDER],
        select: { plan: { select: { profile: { select: { name: true } } } } },
      },
    },
  });
  return new Map(
    rows
      .filter((row) => row.parts.length >= 2)
      .map((row) => [
        row.id,
        { id: row.id, profiles: row.parts.map((part) => part.plan.profile.name) },
      ]),
  );
}

export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

type Reader = Pick<Tx, 'ingredient' | 'mealPlanDay' | '$queryRaw'>;

export async function loadIngredients(
  db: Pick<Tx, 'ingredient'>,
  ids: string[],
): Promise<Map<string, IngredientRow>> {
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

/** One ingredient line of a planned meal, with the day it is for. */
type DatedLine = PlanIngredientLine & { date: Date };

/** Every ingredient line the plan's menu has between two dates, as the menu is now. */
export async function planLines(
  db: Reader,
  planId: string,
  from: Date,
  to: Date,
): Promise<DatedLine[]> {
  const days = await db.mealPlanDay.findMany({
    where: { planId, date: { gte: from, lte: to } },
    select: {
      date: true,
      meals: {
        select: {
          id: true,
          source: true,
          servings: true,
          quantityScale: true,
          leftoverFromDate: true,
          toppingKey: true,
          toppingAmount: true,
          rests: true,
          plate: true,
          recipe: {
            select: {
              servings: true,
              ingredients: {
                orderBy: { position: 'asc' },
                select: {
                  ingredientId: true,
                  quantity: true,
                  unit: true,
                  // What a person's own plate reads a line's part from.
                  ingredient: {
                    select: { slug: true, name: true, category: true, proteinKind: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  // A topping is bought for the plate it is on, as its food of the catalogue.
  const toppings = days.some((day) => day.meals.some((meal) => meal.toppingKey !== null))
    ? await toppingIngredientsOf(db)
    : new Map<string, { id: string; unit: 'g' | 'ml' | 'piece' }>();
  // Eggs and tortillas are bought as their pots take them: whole.
  const pieces = await pieceUsesOf(
    db,
    days.flatMap((day) => day.meals.map((meal) => meal.id)),
  );
  const lines: DatedLine[] = [];
  for (const day of days) {
    for (const meal of day.meals) {
      const topping = meal.toppingKey !== null ? toppings.get(meal.toppingKey) : undefined;
      if (topping && meal.toppingAmount !== null) {
        lines.push({
          date: day.date,
          ingredientId: topping.id,
          quantity: meal.toppingAmount,
          unit: topping.unit,
          recipeServings: 1,
          plannedServings: 1,
        });
      }
      // A custom meal has no ingredients, and a leftover was bought with the
      // meal it was left of. Whether a meal was eaten changes nothing: a list
      // says what the days need, not what is left of them.
      if (meal.source === 'USER_CUSTOM' || !meal.recipe || meal.leftoverFromDate) continue;
      const plate = plateOfMeal(meal.plate);
      for (const line of meal.recipe.ingredients) {
        lines.push({
          date: day.date,
          ingredientId: line.ingredientId,
          // A person's own plate of a shared dish takes each line at its part's share, and its pot an egg whole.
          quantity:
            line.quantity *
            plateShare(plate, line.ingredient) *
            pieceFactorOf(pieces.get(meal.id) ?? [], line.ingredientId),
          unit: line.unit,
          recipeServings: meal.recipe.servings,
          // Effective amount folds the rebalancer multiplier into servings.
          plannedServings: meal.servings * meal.quantityScale,
        });
      }
      // The rest of a pack the meal finishes is part of what the pack is bought for.
      for (const rest of restsOf(meal.rests))
        lines.push({
          date: day.date,
          ingredientId: rest.ingredientId,
          quantity: rest.amount,
          unit: rest.unit,
          recipeServings: 1,
          plannedServings: 1,
        });
    }
  }
  return lines;
}

/** What the plan's menu needs between two dates, by aisle, with the ingredients it names. */
async function planNeeds(db: Reader, planId: string, from: Date, to: Date) {
  const lines = await planLines(db, planId, from, to);
  const ingredients = await loadIngredients(db, [
    ...new Set(lines.map((line) => line.ingredientId)),
  ]);
  return { groups: aggregateShoppingList(lines, ingredients), ingredients };
}

/**
 * Whether the plan's menu still needs what a list says. Compared row by row
 * with what a list made now would hold; a row of an ingredient that no longer
 * exists cannot be compared and makes the list stale.
 */
export function isStale(
  list: Pick<StoredList, 'fromDate' | 'toDate' | 'items'>,
  lines: readonly DatedLine[],
  ingredients: ReadonlyMap<string, IngredientRow>,
): boolean {
  const inRange = lines.filter((line) => line.date >= list.fromDate && line.date <= list.toDate);
  if (inRange.some((line) => !ingredients.has(line.ingredientId))) return true;
  let now: AggregatedItem[];
  try {
    now = aggregateShoppingList(inRange, ingredients as Map<string, IngredientRow>).flatMap(
      (group) => group.items,
    );
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return true;
  }
  if (now.length !== list.items.length) return true;
  const stored = new Map(list.items.map((item) => [item.ingredientId, item]));
  return now.some((item) => {
    const row = stored.get(item.ingredientId);
    return (
      !row || row.unit !== item.unit || Math.abs(row.totalQuantity - item.totalQuantity) > 1e-6
    );
  });
}

/**
 * What the lists count on from the pantry of `profileId` without having taken
 * it yet, per ingredient, in its canonical unit: of the profile's own rows not
 * ticked, the part of what is at home that its pantry holds; of the rows of
 * other profiles of a household list not ticked, what they counted in it
 * (`Borrowed`). A new list sees the stock less these.
 */
async function openClaims(
  tx: Tx,
  profileId: string,
  ingredients: ReadonlyMap<string, ConvertibleIngredient>,
): Promise<Map<string, number>> {
  const ingredientIds = [...ingredients.keys()];
  if (ingredientIds.length === 0) return new Map();
  // One statement: the claims are read for every list that is made.
  const lentBy = JSON.stringify([{ profileId }]);
  const rows = await tx.$queryRaw<
    {
      ingredientId: string;
      unit: Unit;
      alreadyHaveQuantity: number;
      borrowed: unknown;
      owner: string;
    }[]
  >(
    Prisma.sql`SELECT i."ingredientId", i."unit"::text AS "unit", i."alreadyHaveQuantity", i."borrowed", p."profileId" AS "owner" FROM "ShoppingListItem" i JOIN "ShoppingList" l ON l."id" = i."listId" JOIN "MealPlan" p ON p."id" = l."planId" WHERE i."checked" = false AND i."ingredientId" IN (${Prisma.join(ingredientIds)}) AND ((p."profileId" = ${profileId} AND i."alreadyHaveQuantity" > 0) OR i."borrowed" @> ${lentBy}::jsonb)`,
  );
  const claims = new Map<string, number>();
  const claim = (ingredientId: string, unit: Unit, quantity: number): void => {
    const ingredient = ingredients.get(ingredientId)!;
    const amount = inCanonicalUnit(quantity, unit, ingredient);
    if (amount !== null && amount > 0)
      claims.set(ingredientId, (claims.get(ingredientId) ?? 0) + amount);
  };
  for (const row of rows) {
    const borrowed = readBorrowed(row.borrowed);
    if (row.owner === profileId) claim(row.ingredientId, row.unit, ownPart(row, borrowed));
    else
      for (const one of borrowed)
        if (one.profileId === profileId) claim(row.ingredientId, row.unit, one.quantity);
  }
  return claims;
}

/** What of a row's `alreadyHaveQuantity` its own pantry holds: the rest it counted in others' (`borrowed`). */
function ownPart(
  row: Pick<StoredItem, 'alreadyHaveQuantity'>,
  borrowed: readonly Borrowed[],
): number {
  const lent = borrowed.reduce((sum, one) => sum + one.quantity, 0);
  return Math.max(0, Math.round((row.alreadyHaveQuantity - lent) * 1e6) / 1e6);
}

/** What a row did to each pantry it counts on: its own, and each other one of its household (`Borrowed`). */
interface RowLedgers {
  moves: PantryMove[];
  borrowed: Borrowed[];
}

/** A row's ledgers as the row stores them. */
export const stored = (ledgers: RowLedgers) => ({
  pantryMoves: ledgers.moves as unknown as Prisma.InputJsonValue,
  borrowed: ledgers.borrowed as unknown as Prisma.InputJsonValue,
});

/**
 * Bring what a row does to each pantry it counts on to what `state` means for
 * it (`pantryEffects`) and return its ledgers afterwards: of its own pantry and
 * of each one in `borrowed`; those in `dropped` are given back what they gave
 * and are left out. Where the pantries cannot be reached for the row (its
 * ingredient gone, or no longer convertible from the row's unit) nothing
 * changes and the row keeps the ledgers it has. The caller holds the row; the
 * pantries are held here, in the order of their profiles. Packages of a
 * freezer are taken only as the plan of whoever counted on it takes them out.
 */
export async function settleRow(
  tx: Tx,
  owner: { profileId: string; planId: string },
  item: Pick<StoredItem, 'ingredientId' | 'unit' | 'pantryMoves'>,
  state: ShoppingRowState,
  counts: { borrowed: readonly Borrowed[]; dropped?: readonly Borrowed[] },
): Promise<RowLedgers> {
  const { borrowed, dropped = [] } = counts;
  const moves = readMoves(item.pantryMoves);
  const kept: RowLedgers = { moves, borrowed: [...borrowed, ...dropped] };
  const ingredient = await tx.ingredient.findUnique({ where: { id: item.ingredientId } });
  if (!ingredient) return kept;
  const effects = pantryEffects(
    state,
    borrowed.map((one) => one.quantity),
  );
  const own = inCanonicalUnit(effects.own, item.unit, ingredient);
  const others = effects.borrowed.map((effect) => inCanonicalUnit(effect, item.unit, ingredient));
  if (own === null || others.some((effect) => effect === null)) return kept;
  const lenders = [...borrowed, ...dropped];
  for (const profileId of [
    ...new Set([owner.profileId, ...lenders.map((one) => one.profileId)]),
  ].sort())
    await lockPantry(tx, profileId, ingredient.id);
  const thawed = async (planId: string): Promise<ReadonlySet<number> | undefined> =>
    (await thawedParcels(tx, planId)).get(ingredient.id);
  const settled: RowLedgers = {
    moves: await settlePantry(
      tx,
      owner.profileId,
      ingredient,
      moves,
      own,
      await thawed(owner.planId),
    ),
    borrowed: [],
  };
  for (const [k, one] of borrowed.entries()) {
    settled.borrowed.push({
      ...one,
      moves: await settlePantry(
        tx,
        one.profileId,
        ingredient,
        one.moves,
        others[k]!,
        await thawed(one.planId),
      ),
    });
  }
  for (const one of dropped) await settlePantry(tx, one.profileId, ingredient, one.moves, 0);
  return settled;
}

/**
 * What the freezer of `profileId` holds of each food that a list of `planId` does not count (`mayTakeOf`): the packages
 * of a food in packs that the plan does not take out, in the food's canonical unit; foods the rows do not name left out.
 */
export async function frozenKeptOf(
  db: Tx,
  profileId: string,
  planId: string,
  ingredients: ReadonlyMap<string, IngredientRow>,
): Promise<Map<string, number>> {
  const [rows, thawed] = await Promise.all([
    db.inventoryItem.findMany({
      where: { profileId, frozen: true, ingredientId: { in: [...ingredients.keys()] } },
      select: { ingredientId: true, quantity: true, unit: true, parcel: true },
    }),
    thawedParcels(db, planId),
  ]);
  const kept = new Map<string, number>();
  for (const row of rows) {
    const ingredient = ingredients.get(row.ingredientId)!;
    if (mayTakeOf(ingredient, thawed.get(row.ingredientId) ?? NONE)({ ...row, frozen: true }))
      continue;
    const { quantity } = pantryStock([{ ...row, bestBefore: null }], ingredient);
    if (quantity > 0) kept.set(row.ingredientId, (kept.get(row.ingredientId) ?? 0) + quantity);
  }
  return kept;
}

/** An amount in an ingredient's canonical unit in `unit`, to a tenth; 0 where it can no longer be converted. */
function inRowUnit(amount: number, unit: Unit, ingredient: IngredientRow): number {
  try {
    return Math.round(convertUnit(amount, ingredient.canonicalUnit, unit, ingredient) * 10) / 10;
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return 0;
  }
}

/** Nothing of the freezer taken out. */
const NONE: ReadonlySet<number> = new Set();

/**
 * The packages of the freezer a plan takes out (`StoredReport.freezer`), by food: the numbers of those of its
 * profile's freezer. A report kept before packages names package 0, the one frozen row of a food then.
 */
async function thawedParcels(tx: Tx, planId: string): Promise<Map<string, Set<number>>> {
  const made = await tx.mealPlan.findUnique({ where: { id: planId }, select: { report: true } });
  return new Map(
    [...(freezerOf(made?.report)?.stock ?? [])].map(([ingredientId, list]) => [
      ingredientId,
      new Set(list.map((one) => one.parcel)),
    ]),
  );
}

/** A quantity of a row in the canonical unit of its ingredient, or null when the ingredient can no longer be converted from the row's unit. */
function inCanonicalUnit(
  quantity: number,
  unit: Unit,
  ingredient: Parameters<typeof convertUnit>[3] & { canonicalUnit: Unit },
): number | null {
  try {
    return convertUnit(quantity, unit, ingredient.canonicalUnit, ingredient);
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return null;
  }
}

/**
 * What was bought by weight for rows of lists that a new list takes the place of, of the foods the new one has a row for
 * (`ingredients`): by food, what was bought beyond what was at home, in its canonical unit, and the first day it was
 * bought on. It goes over to the new list's row with its day, as the purchase it is ("Zaktualizuj listę").
 */
async function carriedLoose(
  tx: Tx,
  listIds: readonly string[],
  ingredients: ReadonlyMap<string, Parameters<typeof convertUnit>[3] & { canonicalUnit: Unit }>,
): Promise<Map<string, { amount: number; day: Date }>> {
  const carried = new Map<string, { amount: number; day: Date }>();
  if (listIds.length === 0) return carried;
  for (const row of await tx.shoppingListItem.findMany({
    where: { listId: { in: [...listIds] }, boughtLooseOn: { not: null } },
  })) {
    const ingredient = ingredients.get(row.ingredientId);
    const bought = Math.max(
      0,
      (row.purchasedQuantity ?? (row.checked ? row.totalQuantity : 0)) - row.alreadyHaveQuantity,
    );
    const amount = ingredient ? inCanonicalUnit(bought, row.unit, ingredient) : null;
    if (!amount || amount <= 0) continue;
    const before = carried.get(row.ingredientId);
    carried.set(row.ingredientId, {
      amount: (before?.amount ?? 0) + amount,
      day: before && before.day < row.boughtLooseOn! ? before.day : row.boughtLooseOn!,
    });
  }
  return carried;
}

/**
 * Settle the rows of lists that are about to be removed: for each, `share`
 * says how much of what its rows hold for the plan is still in the kitchen
 * and goes into the pantry (see `pantryEffectOnRemoval`), what a row counted in
 * the pantry of another profile of its household going back there
 * (`pantryEffects`). The lists themselves are left for the caller to delete,
 * in the same transaction.
 */
export async function releaseLists(
  tx: Tx,
  profileId: string,
  listIds: readonly string[],
  share: (list: { fromDate: Date; toDate: Date }) => number,
  /**
   * The foods whose purchases by weight go over to the list that takes the place of these (`carriedLoose`): their rows
   * leave the pantries as they found them, and what was bought goes with the purchase.
   */
  carried: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (listIds.length === 0) return;
  // Rows first, then the pantries: the order every writer takes its locks in.
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "ShoppingListItem" WHERE "listId" IN (${Prisma.join(listIds)}) ORDER BY "id" FOR UPDATE`,
  );
  const lists = await tx.shoppingList.findMany({
    where: { id: { in: [...listIds] } },
    include: { items: true },
  });
  // A row that did nothing to a pantry and is to do nothing to one has
  // nothing to settle: of a list nobody shopped from, that is every row.
  const rows = lists
    .flatMap((list) =>
      list.items.map((item) => {
        const borrowed = readBorrowed(item.borrowed);
        const effects =
          item.boughtLooseOn && carried.has(item.ingredientId)
            ? pantryEffects(
                { ...item, purchasedQuantity: null, checked: false },
                borrowed.map((one) => one.quantity),
              )
            : pantryEffects(
                item,
                borrowed.map((one) => one.quantity),
                share(list),
              );
        return { item, borrowed, effects };
      }),
    )
    .filter(
      ({ item, borrowed, effects }) =>
        effects.own !== 0 ||
        readMoves(item.pantryMoves).length > 0 ||
        borrowed.some((one, k) => effects.borrowed[k] !== 0 || one.moves.length > 0),
    );
  if (rows.length === 0) return;
  rows.sort((a, b) =>
    a.item.ingredientId === b.item.ingredientId
      ? 0
      : a.item.ingredientId < b.item.ingredientId
        ? -1
        : 1,
  );

  const ingredients = new Map(
    (
      await tx.ingredient.findMany({
        where: { id: { in: [...new Set(rows.map(({ item }) => item.ingredientId))] } },
      })
    ).map((ingredient) => [ingredient.id, ingredient]),
  );
  // A row whose ingredient is gone, or can no longer be converted from the row's unit, leaves the pantries as they are.
  const settled = rows.flatMap(({ item, borrowed, effects }) => {
    const ingredient = ingredients.get(item.ingredientId);
    if (!ingredient) return [];
    const own = inCanonicalUnit(effects.own, item.unit, ingredient);
    const others = effects.borrowed.map((effect) => inCanonicalUnit(effect, item.unit, ingredient));
    return own === null || others.some((effect) => effect === null)
      ? []
      : [{ item, ingredient, own, borrowed, others: others as number[] }];
  });
  // The pantries by profile, each of its ingredients in order.
  const pantries = new Map<string, string[]>([[profileId, []]]);
  for (const { ingredient, borrowed } of settled) {
    for (const holder of [profileId, ...borrowed.map((one) => one.profileId)])
      pantries.set(holder, [...(pantries.get(holder) ?? []), ingredient.id]);
  }
  for (const holder of [...pantries.keys()].sort())
    await lockPantries(tx, holder, pantries.get(holder)!);
  for (const { item, ingredient, own, borrowed, others } of settled) {
    await settlePantry(tx, profileId, ingredient, readMoves(item.pantryMoves), own);
    for (const [k, one] of borrowed.entries())
      await settlePantry(tx, one.profileId, ingredient, one.moves, others[k]!);
  }
}

/**
 * Settle every list of a plan that is about to be deleted, by the rule of
 * `ShoppingListsService.remove`. The plan's deletion then removes the lists;
 * the household lists they were parts of, returned, are for
 * `settleHouseholds` once it has.
 */
export async function releasePlanLists(
  tx: Tx,
  planId: string,
  profileId: string,
  today: Date = new Date(),
): Promise<string[]> {
  const lists = await tx.shoppingList.findMany({
    where: { planId },
    select: { id: true, householdId: true },
  });
  await releaseLists(
    tx,
    profileId,
    lists.map((list) => list.id),
    (dates) => shareAhead(dates.fromDate, dates.toDate, today),
  );
  return lists.flatMap((list) => (list.householdId ? [list.householdId] : []));
}

/**
 * Make the list of a plan's days `from` to `to`, a part of the household list
 * `householdId` when one is named. The plan's lists that share a day with it
 * are replaced: what was obtained for them goes into the pantry first, so the
 * new list finds it there and asks only for what is missing. Returns the new
 * list and the household lists that lost a part to it.
 */
export async function makeList(
  tx: Tx,
  plan: { id: string; profileId: string },
  from: Date,
  to: Date,
  householdId: string | null = null,
): Promise<{ listId: string; leftHouseholds: string[] }> {
  const profileId = plan.profileId;
  // One list of a profile at a time: each counts on what the others left.
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shopping:${profileId}`}, 0))`,
  );
  // The menu must not change between reading it and writing the list.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "id" = ${plan.id} FOR UPDATE`);

  const overlapping = await tx.shoppingList.findMany({
    where: { planId: plan.id, fromDate: { lte: to }, toDate: { gte: from } },
    select: { id: true, householdId: true },
  });
  const needs = await planNeeds(tx, plan.id, from, to);
  const carried = await carriedLoose(
    tx,
    overlapping.map((list) => list.id),
    needs.ingredients,
  );
  await releaseLists(
    tx,
    profileId,
    overlapping.map((list) => list.id),
    () => 1,
    new Set(carried.keys()),
  );
  await tx.shoppingList.deleteMany({
    where: { id: { in: overlapping.map((list) => list.id) } },
  });

  if ((await tx.shoppingList.count({ where: { planId: plan.id } })) >= MAX_LISTS_PER_PLAN) {
    throw new ConflictException({
      error: 'SHOPPING_LIST_LIMIT',
      message: `A plan has at most ${MAX_LISTS_PER_PLAN} shopping lists. Delete one first.`,
    });
  }

  const items = needs.groups.flatMap((group) => group.items);
  const claimed = await openClaims(tx, profileId, needs.ingredients);

  const list = await tx.shoppingList.create({
    data: { planId: plan.id, fromDate: from, toDate: to, householdId },
  });
  // A list of four weeks names some hundreds of ingredients: their
  // pantries are held, and read, with one statement each, not one an
  // ingredient. The list has one row for an ingredient, so what is read
  // here of an ingredient is what its row finds.
  const ingredientIds = items.map((item) => item.ingredientId);
  await lockPantries(tx, profileId, ingredientIds);
  // What the list counts on, and takes from: what is fresh, every package of a food no plan takes out of a freezer
  // (not perishable in packs), and of any other food the packages the plan takes out (`mayTakeOf`).
  const thawed = await thawedParcels(tx, plan.id);
  const pantry = new Map<string, { unit: Unit; quantity: number; bestBefore: Date | null }[]>();
  for (const row of await tx.inventoryItem.findMany({
    where: { profileId, ingredientId: { in: ingredientIds } },
    select: {
      ingredientId: true,
      unit: true,
      quantity: true,
      bestBefore: true,
      frozen: true,
      parcel: true,
      ingredient: { select: { perishable: true, packSize: true } },
    },
  })) {
    if (!mayTakeOf(row.ingredient, thawed.get(row.ingredientId) ?? NONE)(row)) continue;
    pantry.set(row.ingredientId, [...(pantry.get(row.ingredientId) ?? []), row]);
  }

  const rows: Prisma.ShoppingListItemCreateManyInput[] = [];
  for (const item of [...items].sort((a, b) => (a.ingredientId < b.ingredientId ? -1 : 1))) {
    const ingredient = needs.ingredients.get(item.ingredientId)!;
    const stock = pantryStock(pantry.get(ingredient.id) ?? [], ingredient);
    const free = stock.quantity - (claimed.get(ingredient.id) ?? 0);
    const have = quantityToClaim(
      convertUnit(free, ingredient.canonicalUnit, item.unit, ingredient),
      item.unit,
      item.totalQuantity,
    );
    // What was bought by weight for a list this one takes the place of goes over with its day: all of it is the plan's.
    const loose = carried.get(item.ingredientId);
    const bought = loose ? (inRowUnitOrNull(loose.amount, item.unit, ingredient) ?? 0) : 0;
    const purchased = Math.round((have + bought) * 1e6) / 1e6;
    // A need the pantry covers in full needs no shopping, nor one what was bought covers: the row arrives ticked, and
    // what it counts on leaves the pantry now.
    const covered = purchased > 0 && purchased >= item.totalQuantity;
    const moves = covered
      ? await settlePantry(
          tx,
          profileId,
          ingredient,
          [],
          -convertUnit(have, item.unit, ingredient.canonicalUnit, ingredient),
          thawed.get(ingredient.id),
        )
      : [];
    rows.push({
      listId: list.id,
      ingredientId: item.ingredientId,
      name: item.name,
      category: item.category,
      totalQuantity: item.totalQuantity,
      unit: item.unit,
      alreadyHaveQuantity: have,
      // One number for the user to raise as they shop: it starts at what is at home.
      purchasedQuantity: purchased > 0 ? purchased : null,
      boughtLooseOn: bought > 0 ? loose!.day : null,
      checked: covered,
      pantryMoves: moves as unknown as Prisma.InputJsonValue,
      pantryBestBefore: have > 0 ? stock.bestBefore : null,
      estimatedCalories: item.estimatedCalories,
    });
  }
  await tx.shoppingListItem.createMany({ data: rows });
  return {
    listId: list.id,
    leftHouseholds: overlapping.flatMap((old) => (old.householdId ? [old.householdId] : [])),
  };
}

/**
 * One kitchen: the parts of a household list just made (`makeList`, each
 * against its own profile's pantry) count on the pantries of the others for
 * what their own leaves short. A row not covered counts, profile by profile in
 * the order of their ids, on what another part's profile holds of the food
 * that its plan may take, less what that profile's lists count on already
 * (`openClaims`) and what this pass counted in it before, rounded down as a
 * claim is (`quantityToClaim`). A row then covered in full arrives ticked, as
 * one its own pantry covers does: what it counts on leaves each pantry now.
 */
export async function borrowAcross(
  tx: Tx,
  parts: readonly { listId: string; profileId: string; planId: string }[],
): Promise<void> {
  if (parts.length < 2) return;
  const order = [...parts].sort((a, b) => (a.profileId < b.profileId ? -1 : 1));
  const rank = new Map(order.map((part, k) => [part.listId, k]));
  // Of one food, the parts in the order of their profiles.
  const rows = (
    await tx.shoppingListItem.findMany({
      where: { listId: { in: order.map((part) => part.listId) }, checked: false },
    })
  )
    .filter((row) => row.alreadyHaveQuantity < row.totalQuantity)
    .sort((a, b) =>
      a.ingredientId === b.ingredientId
        ? rank.get(a.listId)! - rank.get(b.listId)!
        : a.ingredientId < b.ingredientId
          ? -1
          : 1,
    );
  if (rows.length === 0) return;
  const ids = [...new Set(rows.map((row) => row.ingredientId))];
  const ingredients = new Map(
    (await tx.ingredient.findMany({ where: { id: { in: ids } } })).map((one) => [one.id, one]),
  );
  // Every pantry of the foods, profile by profile: those of the parts' own foods are held already.
  for (const part of order) await lockPantries(tx, part.profileId, ids);

  /** What each part's profile holds of each food that its plan may take and its lists do not count on yet. */
  const free = new Map<string, Map<string, { quantity: number; bestBefore: Date | null }>>();
  for (const part of order) {
    const thawed = await thawedParcels(tx, part.planId);
    const claims = await openClaims(tx, part.profileId, ingredients);
    const held = new Map<string, { unit: Unit; quantity: number; bestBefore: Date | null }[]>();
    for (const row of await tx.inventoryItem.findMany({
      where: { profileId: part.profileId, ingredientId: { in: ids } },
      select: {
        ingredientId: true,
        unit: true,
        quantity: true,
        bestBefore: true,
        frozen: true,
        parcel: true,
      },
    })) {
      const ingredient = ingredients.get(row.ingredientId)!;
      if (!mayTakeOf(ingredient, thawed.get(row.ingredientId) ?? NONE)(row)) continue;
      held.set(row.ingredientId, [...(held.get(row.ingredientId) ?? []), row]);
    }
    free.set(
      part.profileId,
      new Map(
        [...held].map(([ingredientId, stock]) => {
          const { quantity, bestBefore } = pantryStock(stock, ingredients.get(ingredientId)!);
          return [
            ingredientId,
            { quantity: quantity - (claims.get(ingredientId) ?? 0), bestBefore },
          ];
        }),
      ),
    );
  }

  const partOf = new Map(order.map((part) => [part.listId, part]));
  for (const row of rows) {
    const part = partOf.get(row.listId)!;
    const ingredient = ingredients.get(row.ingredientId);
    if (!ingredient) continue;
    let have = row.alreadyHaveQuantity;
    let bestBefore = row.pantryBestBefore;
    const borrowed: Borrowed[] = [];
    for (const lender of order) {
      if (lender.profileId === part.profileId || have >= row.totalQuantity) continue;
      const theirs = free.get(lender.profileId)!.get(row.ingredientId);
      if (!theirs || theirs.quantity <= 0) continue;
      const available = inRowUnitOrNull(theirs.quantity, row.unit, ingredient);
      if (available === null) continue;
      const take = quantityToClaim(
        available,
        row.unit,
        Math.round((row.totalQuantity - have) * 1e6) / 1e6,
      );
      if (take <= 0) continue;
      theirs.quantity -= inCanonicalUnit(take, row.unit, ingredient) ?? 0;
      have = Math.round((have + take) * 1e6) / 1e6;
      borrowed.push({
        profileId: lender.profileId,
        planId: lender.planId,
        quantity: take,
        moves: [],
      });
      if (theirs.bestBefore && (!bestBefore || theirs.bestBefore < bestBefore))
        bestBefore = theirs.bestBefore;
    }
    if (borrowed.length === 0) continue;
    // What was bought for the row already (a purchase by weight that went over from a list replaced) stays bought.
    const bought = Math.max(0, (row.purchasedQuantity ?? 0) - row.alreadyHaveQuantity);
    const purchased = Math.round((have + bought) * 1e6) / 1e6;
    const state = {
      totalQuantity: row.totalQuantity,
      alreadyHaveQuantity: have,
      purchasedQuantity: purchased,
      checked: purchased >= row.totalQuantity,
      boughtLooseOn: row.boughtLooseOn,
    };
    const ledgers = state.checked
      ? await settleRow(tx, part, row, state, { borrowed })
      : { moves: readMoves(row.pantryMoves), borrowed };
    await tx.shoppingListItem.update({
      where: { id: row.id },
      data: {
        alreadyHaveQuantity: state.alreadyHaveQuantity,
        purchasedQuantity: state.purchasedQuantity,
        checked: state.checked,
        pantryBestBefore: bestBefore,
        ...stored(ledgers),
      },
    });
  }
}

/** An amount in an ingredient's canonical unit in `unit`, or null where it cannot be converted. */
function inRowUnitOrNull(
  amount: number,
  unit: Unit,
  ingredient: Parameters<typeof convertUnit>[3] & { canonicalUnit: Unit },
): number | null {
  try {
    return convertUnit(amount, ingredient.canonicalUnit, unit, ingredient);
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return null;
  }
}

/**
 * Household lists left with fewer than two parts go: the part one of them
 * keeps is its plan's list alone from then on. What a part's rows not ticked
 * count on in the pantry of a profile no longer of its household (every other
 * profile, once the household is gone) is not at home for them any more; a
 * ticked row keeps what it took, so that taking its tick back returns it.
 */
export async function settleHouseholds(tx: Tx, ids: readonly string[]): Promise<void> {
  const named = [...new Set(ids)];
  if (named.length === 0) return;
  const parts = await tx.shoppingList.findMany({
    where: { householdId: { in: named } },
    select: { id: true, householdId: true, plan: { select: { profileId: true } } },
  });
  const profilesOf = new Map<string, Set<string>>();
  for (const part of parts)
    profilesOf.set(
      part.householdId!,
      (profilesOf.get(part.householdId!) ?? new Set()).add(part.plan.profileId),
    );
  const kept = new Set(named.filter((id) => (profilesOf.get(id)?.size ?? 0) >= 2));
  const gone = named.filter((id) => !kept.has(id));
  if (gone.length > 0) await tx.householdList.deleteMany({ where: { id: { in: gone } } });

  const rows = await tx.shoppingListItem.findMany({
    where: {
      listId: { in: parts.map((part) => part.id) },
      checked: false,
      NOT: { borrowed: { equals: [] } },
    },
    orderBy: { id: 'asc' },
  });
  const partOf = new Map(parts.map((part) => [part.id, part]));
  for (const row of rows) {
    const part = partOf.get(row.listId)!;
    const stays = kept.has(part.householdId!)
      ? profilesOf.get(part.householdId!)!
      : new Set([part.plan.profileId]);
    const borrowed = readBorrowed(row.borrowed);
    const left = borrowed.filter((one) => !stays.has(one.profileId));
    if (left.length === 0) continue;
    const lost = left.reduce((sum, one) => sum + one.quantity, 0);
    // Nothing was taken for a row not ticked; what a ledger may still name goes back.
    const ingredient = await tx.ingredient.findUnique({ where: { id: row.ingredientId } });
    for (const one of left) {
      if (ingredient && one.moves.length > 0) {
        await lockPantry(tx, one.profileId, ingredient.id);
        await settlePantry(tx, one.profileId, ingredient, one.moves, 0);
      }
    }
    await tx.shoppingListItem.update({
      where: { id: row.id },
      data: {
        ...withAtHome(row, row.alreadyHaveQuantity - lost),
        borrowed: borrowed.filter((one) =>
          stays.has(one.profileId),
        ) as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

/**
 * What the rows of other profiles' lists counted on in the pantry of a profile that is about to be deleted is
 * forgotten: a row not ticked no longer has it at home; a ticked one holds what it took for its plan as if it had
 * bought it, so that taking its tick back returns nothing to a pantry that is gone. Nothing changes in another
 * pantry. The profile's own lists go with it; what they counted in others' pantries for the days ahead goes back
 * there first (`releaseLists`).
 */
export async function forgetLender(
  tx: Tx,
  profileId: string,
  today: Date = new Date(),
): Promise<void> {
  const own = await tx.shoppingList.findMany({
    where: { plan: { profileId }, items: { some: { NOT: { borrowed: { equals: [] } } } } },
    select: { id: true },
  });
  await releaseLists(
    tx,
    profileId,
    own.map((list) => list.id),
    (dates) => shareAhead(dates.fromDate, dates.toDate, today),
  );
  const rows = await tx.shoppingListItem.findMany({
    where: {
      borrowed: { array_contains: [{ profileId }] },
      list: { plan: { profileId: { not: profileId } } },
    },
    orderBy: { id: 'asc' },
  });
  for (const row of rows) {
    const borrowed = readBorrowed(row.borrowed);
    const lent = borrowed
      .filter((one) => one.profileId === profileId)
      .reduce((sum, one) => sum + one.quantity, 0);
    const state = row.checked
      ? {
          alreadyHaveQuantity: Math.max(
            0,
            Math.round((row.alreadyHaveQuantity - lent) * 1e6) / 1e6,
          ),
          purchasedQuantity: row.purchasedQuantity ?? row.totalQuantity,
          checked: true,
        }
      : withAtHome(row, row.alreadyHaveQuantity - lent);
    await tx.shoppingListItem.update({
      where: { id: row.id },
      data: {
        ...state,
        borrowed: borrowed.filter(
          (one) => one.profileId !== profileId,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

/** A row of the pantry that is gone, as the moves of a list's row name the row they were made to. */
export interface GoneStock {
  unit: Unit;
  frozen: boolean;
  parcel: number | null;
}

/**
 * Hold the rows of lists that count on the pantry of `profileId` for a food, the profile's own and those of other
 * profiles of a household list that counted on it, and then the pantries of the food that those rows count on, in the
 * order of their profiles: rows first, the order every writer takes its locks in. For a change of the pantry that the
 * lists follow (`forgetStock`), which may settle each of those pantries; the caller's own `lockPantry` then holds
 * what it holds already.
 */
export async function lockStockRows(
  tx: Tx,
  profileId: string,
  ingredientId: string,
): Promise<void> {
  const lentBy = JSON.stringify([{ profileId }]);
  const rows = await tx.$queryRaw<{ owner: string; borrowed: unknown }[]>(
    Prisma.sql`SELECT p."profileId" AS "owner", i."borrowed" FROM "ShoppingListItem" i JOIN "ShoppingList" l ON l."id" = i."listId" JOIN "MealPlan" p ON p."id" = l."planId" WHERE (p."profileId" = ${profileId} OR i."borrowed" @> ${lentBy}::jsonb) AND i."ingredientId" = ${ingredientId} ORDER BY i."id" FOR UPDATE OF i`,
  );
  const holders = new Set([profileId]);
  for (const row of rows) {
    holders.add(row.owner);
    for (const one of readBorrowed(row.borrowed)) holders.add(one.profileId);
  }
  for (const holder of [...holders].sort()) await lockPantry(tx, holder, ingredientId);
}

/**
 * The lists follow the pantry: what it no longer holds of a food is at home for none of them. Run in the transaction
 * that removed a row of the pantry (`gone`) or lowered one (`gone` null), the lists' rows of the food held first
 * (`lockStockRows`) and then the pantry. The rows that count on it are the profile's own (their own part of what is
 * at home) and those of other profiles of a household list that counted on it (`Borrowed`). A row that took food from
 * the row that is gone loses that part of what is at home, as when its pencil says so (`withAtHome`): it unticks
 * where it no longer meets the need, and the rest of its ledgers is settled; what it took from the row that is gone
 * is forgotten, so nothing of it comes back when the list goes, and what it put there of what was bought is not at
 * home either. A row that counts on the pantry without having taken anything (not ticked) then counts on no more than
 * the pantry holds of the food that it may take, the rows of older lists first.
 */
export async function forgetStock(
  tx: Tx,
  profileId: string,
  ingredientId: string,
  gone: GoneStock | null,
): Promise<void> {
  const ingredient = await tx.ingredient.findUnique({ where: { id: ingredientId } });
  if (!ingredient) return;
  const inUnit = (quantity: number, from: Unit, to: Unit): number | null => {
    try {
      return convertUnit(quantity, from, to, ingredient);
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      return null;
    }
  };
  const read = async () =>
    (
      await tx.shoppingListItem.findMany({
        where: {
          ingredientId,
          OR: [
            { list: { plan: { profileId } } },
            { borrowed: { array_contains: [{ profileId }] } },
          ],
        },
        include: {
          list: {
            select: {
              planId: true,
              createdAt: true,
              householdId: true,
              plan: { select: { profileId: true } },
            },
          },
        },
        orderBy: [{ list: { createdAt: 'asc' } }, { id: 'asc' }],
      })
    ).map((row) => {
      const borrowed = readBorrowed(row.borrowed);
      const own = row.list.plan.profileId === profileId;
      // What the row counts on in this pantry: its own part, or what it counted in it for another profile's part.
      const entry = own ? null : (borrowed.find((one) => one.profileId === profileId) ?? null);
      return { row, borrowed, own, entry };
    });
  const thawedOf = new Map<string, ReadonlySet<number>>();
  const thawed = async (planId: string): Promise<ReadonlySet<number>> => {
    if (!thawedOf.has(planId))
      thawedOf.set(planId, (await thawedParcels(tx, planId)).get(ingredientId) ?? new Set());
    return thawedOf.get(planId)!;
  };
  const households = new Set<string>();
  type Read = Awaited<ReturnType<typeof read>>[number];
  /** A row's new state, its ledgers settled to what the row now means to do to each pantry. */
  const write = async (
    { row }: Read,
    state: Pick<ShoppingRowState, 'alreadyHaveQuantity' | 'purchasedQuantity' | 'checked'>,
    moves: readonly PantryMove[],
    borrowed: readonly Borrowed[],
  ): Promise<void> => {
    const ledgers = await settleRow(
      tx,
      { profileId: row.list.plan.profileId, planId: row.list.planId },
      { ...row, pantryMoves: moves as unknown as Prisma.JsonValue },
      { ...row, ...state },
      { borrowed },
    );
    await tx.shoppingListItem.update({
      where: { id: row.id },
      data: {
        ...state,
        ...(state.alreadyHaveQuantity === 0 ? { pantryBestBefore: null } : {}),
        ...stored(ledgers),
      },
    });
    if (row.list.householdId) households.add(row.list.householdId);
  };

  // What the rows took from the row that is gone, or put there.
  if (gone) {
    const there = (move: PantryMove): boolean =>
      move.unit === gone.unit &&
      Boolean(move.frozen) === gone.frozen &&
      (move.parcel ?? 0) === (gone.parcel ?? 0);
    for (const found of await read()) {
      const { row, borrowed, own, entry } = found;
      const moves = readMoves(row.pantryMoves);
      const ledger = own ? moves : (entry?.moves ?? []);
      if (!ledger.some(there)) continue;
      const net = ledger.filter(there).reduce((sum, move) => sum + move.quantity, 0);
      const lost = inUnit(net, gone.unit, row.unit);
      if (lost === null) continue;
      if (own) {
        const state =
          lost < 0
            ? withAtHome(row, row.alreadyHaveQuantity + lost)
            : {
                alreadyHaveQuantity: row.alreadyHaveQuantity,
                purchasedQuantity: Math.max(0, (row.purchasedQuantity ?? row.totalQuantity) - lost),
                checked: row.checked,
              };
        await write(
          found,
          state,
          moves.filter((move) => !there(move)),
          borrowed,
        );
      } else {
        // What it counted in this pantry and took from the row that is gone is not at home for it any more.
        const taken = Math.max(0, -lost);
        await write(
          found,
          withAtHome(row, row.alreadyHaveQuantity - taken),
          moves,
          borrowed.map((one) =>
            one === entry
              ? {
                  ...one,
                  quantity: Math.max(0, Math.round((one.quantity - taken) * 1e6) / 1e6),
                  moves: one.moves.filter((move) => !there(move)),
                }
              : one,
          ),
        );
      }
    }
  }

  // What the rows not ticked count on, within what the pantry still holds that each may take.
  const stock = await tx.inventoryItem.findMany({
    where: { profileId, ingredientId },
    select: { unit: true, quantity: true, frozen: true, parcel: true },
  });
  let counted = 0;
  for (const found of await read()) {
    const { row, borrowed, own, entry } = found;
    if (row.checked) continue;
    const part = own ? ownPart(row, borrowed) : (entry?.quantity ?? 0);
    if (part <= 0) continue;
    const claim = inUnit(part, row.unit, ingredient.canonicalUnit);
    if (claim === null) continue;
    const may = mayTakeOf(ingredient, await thawed(own ? row.list.planId : entry!.planId));
    const held = stock
      .filter(may)
      .reduce(
        (sum, one) => sum + (inUnit(one.quantity, one.unit, ingredient.canonicalUnit) ?? 0),
        0,
      );
    const kept = Math.max(0, Math.min(claim, held - counted));
    counted += kept;
    if (kept >= claim - 1e-6) continue;
    const have = inUnit(kept, ingredient.canonicalUnit, row.unit);
    if (have === null) continue;
    await write(
      found,
      withAtHome(row, row.alreadyHaveQuantity - (part - have)),
      readMoves(row.pantryMoves),
      own ? borrowed : borrowed.map((one) => (one === entry ? { ...one, quantity: have } : one)),
    );
  }
  await settleHouseholds(tx, [...households]);
}
