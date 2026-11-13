// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  GenerateHouseholdListRequest,
  HouseholdList,
  HouseholdListItem,
  Locale,
  UpdateShoppingItemRequest,
} from '@diet-app/shared';
import {
  editRow,
  energyOf,
  groupByAisle,
  intendedPantryEffect,
  shareAhead,
  shareAtHome,
  sharePurchase,
  withAtHome,
} from '../engine/index.js';
import { assertWithinCeiling } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  isoDate,
  isStale,
  freshOf,
  itemDto,
  loadIngredients,
  makeList,
  PART_ORDER,
  planLines,
  releaseLists,
  settleHouseholds,
  settleRow,
  TRANSACTION,
  type StoredItem,
} from './shopping-lists.service.js';

/** A household list as it is read: its parts, each with its rows and the profile its plan is for. */
const WITH_PARTS = {
  parts: {
    orderBy: [...PART_ORDER],
    include: {
      items: true,
      plan: { select: { id: true, profileId: true, profile: { select: { name: true } } } },
    },
  },
} satisfies Prisma.HouseholdListInclude;

type StoredHousehold = Prisma.HouseholdListGetPayload<{ include: typeof WITH_PARTS }>;
type StoredPart = StoredHousehold['parts'][number];

const clean = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * One shopping list for the plans of several profiles of an account, for the
 * same days. It is made of each plan's own list, its part, which keeps what a
 * list of its plan alone keeps: its pantry and what the profile's other lists
 * claim of it, the days its plan says are on a list, its staleness. The
 * household list sums the parts' rows by ingredient and shares out what is
 * said of a summed row among the parts' rows.
 *
 * Several profiles in one transaction take their locks in one order: the rows
 * of lists by id, then the pantries by profile, so two changes of household
 * lists wait for each other and never each hold what the other wants.
 */
@Injectable()
export class HouseholdListsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Make the household list of `req.planIds` for the days `req.fromDate` to
   * `req.toDate`: of each plan the days it has. Each plan's lists that share
   * a day with its part are replaced, as by a list of its own.
   */
  async generate(
    userId: string,
    locale: Locale,
    req: GenerateHouseholdListRequest,
  ): Promise<HouseholdList> {
    const plans = await this.prisma.mealPlan.findMany({
      where: { id: { in: req.planIds } },
      include: { profile: true, days: { orderBy: { date: 'asc' }, select: { date: true } } },
    });
    if (plans.length !== req.planIds.length || plans.some((plan) => plan.profile.userId !== userId))
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (new Set(plans.map((plan) => plan.profileId)).size !== plans.length) {
      throw new BadRequestException({
        error: 'HOUSEHOLD_PROFILE_TWICE',
        message: 'A household list takes one plan of each profile.',
      });
    }
    const from = new Date(req.fromDate);
    const to = new Date(req.toDate);
    const parts = plans
      .map((plan) => {
        const first = plan.days[0]?.date ?? plan.startDate;
        const last = plan.days.at(-1)?.date ?? plan.startDate;
        const partFrom = from > first ? from : first;
        const partTo = to < last ? to : last;
        if (partFrom > partTo) {
          throw new BadRequestException({
            error: 'SHOPPING_RANGE_OUTSIDE_PLAN',
            message: `The plan ${plan.id} has no day from ${req.fromDate} to ${req.toDate}: it runs from ${isoDate(first)} to ${isoDate(last)}.`,
          });
        }
        return { plan: { id: plan.id, profileId: plan.profileId }, from: partFrom, to: partTo };
      })
      .sort((a, b) => (a.plan.profileId < b.plan.profileId ? -1 : 1));

    const id = await this.prisma.$transaction(async (tx) => {
      // The profiles' lists, the plans and the rows of the lists that are to
      // go, each in one order, before any part is made.
      for (const part of parts) {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shopping:${part.plan.profileId}`}, 0))`,
        );
      }
      const planIds = parts.map((part) => part.plan.id).sort();
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "id" IN (${Prisma.join(planIds)}) ORDER BY "id" FOR UPDATE`,
      );
      const replaced = await tx.shoppingList.findMany({
        where: {
          OR: parts.map((part) => ({
            planId: part.plan.id,
            fromDate: { lte: part.to },
            toDate: { gte: part.from },
          })),
        },
        select: { id: true },
      });
      if (replaced.length > 0) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ShoppingListItem" WHERE "listId" IN (${Prisma.join(replaced.map((list) => list.id))}) ORDER BY "id" FOR UPDATE`,
        );
      }

      const household = await tx.householdList.create({
        data: { userId, fromDate: from, toDate: to },
      });
      const left: string[] = [];
      for (const part of parts) {
        const made = await makeList(tx, part.plan, part.from, part.to, household.id);
        left.push(...made.leftHouseholds);
      }
      await settleHouseholds(
        tx,
        left.filter((other) => other !== household.id),
      );
      return household.id;
    }, TRANSACTION);
    return this.get(userId, locale, id);
  }

  /** The household lists of the account, the newest first. */
  async list(userId: string, locale: Locale): Promise<HouseholdList[]> {
    const rows = await this.prisma.householdList.findMany({
      where: { userId },
      include: WITH_PARTS,
      orderBy: { createdAt: 'desc' },
    });
    return this.toDtos(
      rows.filter((row) => row.parts.length >= 2),
      locale,
    );
  }

  async get(userId: string, locale: Locale, id: string): Promise<HouseholdList> {
    return (await this.toDtos([await this.loadOwned(userId, id)], locale))[0]!;
  }

  /**
   * Change a row of the household list: the rows of its parts for the same
   * ingredient, each by the rules of a list of its plan alone (`editRow`,
   * `withAtHome`). What is at home is shared as the pantries had it
   * (`shareAtHome`), what the household holds for the row so that each plan
   * first has what it lacks and the rest goes by need (`sharePurchase`); a
   * tick or an untick is each part's.
   */
  async updateItem(
    userId: string,
    locale: Locale,
    id: string,
    itemId: string,
    patch: UpdateShoppingItemRequest,
  ): Promise<HouseholdList> {
    const household = await this.loadOwned(userId, id);
    const named = household.parts.flatMap((part) => part.items).find((item) => item.id === itemId);
    if (!named) throw itemNotFound();
    const profileOf = new Map(
      household.parts.flatMap((part) => part.items.map((item) => [item.id, part.plan.profileId])),
    );
    const ids = household.parts
      .flatMap((part) => part.items)
      .filter((item) => item.ingredientId === named.ingredientId && item.unit === named.unit)
      .map((item) => item.id);
    if (patch.purchasedQuantity != null) assertWithinCeiling(patch.purchasedQuantity, named.unit);

    await this.prisma.$transaction(async (tx) => {
      // Read under a lock, so that a second change of the row waits for this one and works from what it left.
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ShoppingListItem" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`,
      );
      if (locked.length !== ids.length) throw itemNotFound();
      const rows = (await tx.shoppingListItem.findMany({ where: { id: { in: ids } } })).sort(
        (a, b) => (profileOf.get(a.id)! < profileOf.get(b.id)! ? -1 : 1),
      );

      // What is at home is said first: the quantity and the tick of the same request are read against it.
      const { alreadyHaveQuantity, ...edit } = patch;
      const atHomes =
        alreadyHaveQuantity === undefined
          ? null
          : shareAtHome(
              alreadyHaveQuantity,
              rows.map((row) => ({ need: row.totalQuantity, atHome: row.alreadyHaveQuantity })),
            );
      const counted = rows.map((row, k) => (atHomes ? withAtHome(row, atHomes[k]!) : null));
      const states = rows.map((row, k) => ({ ...row, ...counted[k] }));
      const held =
        edit.purchasedQuantity === undefined
          ? null
          : edit.purchasedQuantity === null
            ? states.map(() => null)
            : sharePurchase(
                edit.purchasedQuantity,
                states.map((row) => ({ need: row.totalQuantity, atHome: row.alreadyHaveQuantity })),
              );

      // The pantries by profile: the order of every change of more than one.
      for (const [k, row] of rows.entries()) {
        const next = {
          ...counted[k],
          ...editRow(states[k]!, {
            ...(held ? { purchasedQuantity: held[k]! } : {}),
            ...(edit.checked === undefined ? {} : { checked: edit.checked }),
          }),
          // The date was that of what the pantry held for the row: with nothing at home there is none.
          ...(counted[k]?.alreadyHaveQuantity === 0 ? { pantryBestBefore: null } : {}),
        };
        const moves = await settleRow(
          tx,
          profileOf.get(row.id)!,
          row,
          intendedPantryEffect({ ...row, ...next }),
        );
        await tx.shoppingListItem.update({
          where: { id: row.id },
          data: {
            ...next,
            ...(moves ? { pantryMoves: moves as unknown as Prisma.InputJsonValue } : {}),
          },
        });
      }
    }, TRANSACTION);
    return this.get(userId, locale, id);
  }

  /**
   * Delete a household list and its parts, each by the rule of a list of its
   * plan alone: what was obtained for the days still ahead goes into the
   * pantry of the part's profile.
   */
  async remove(userId: string, id: string, today: Date = new Date()): Promise<void> {
    const household = await this.loadOwned(userId, id);
    await this.prisma.$transaction(async (tx) => {
      const listIds = household.parts.map((part) => part.id);
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "ShoppingListItem" WHERE "listId" IN (${Prisma.join(listIds)}) ORDER BY "id" FOR UPDATE`,
      );
      const byProfile = [...household.parts].sort((a, b) =>
        a.plan.profileId < b.plan.profileId ? -1 : 1,
      );
      for (const part of byProfile) {
        await releaseLists(tx, part.plan.profileId, [part.id], (dates) =>
          shareAhead(dates.fromDate, dates.toDate, today),
        );
      }
      await tx.shoppingList.deleteMany({ where: { householdId: id } });
      await tx.householdList.deleteMany({ where: { id } });
    }, TRANSACTION);
  }

  private async loadOwned(userId: string, id: string): Promise<StoredHousehold> {
    const household = await this.prisma.householdList.findUnique({
      where: { id },
      include: WITH_PARTS,
    });
    // One left with a single part is that plan's list alone.
    if (!household || household.userId !== userId || household.parts.length < 2) {
      throw new NotFoundException({
        error: 'HOUSEHOLD_LIST_NOT_FOUND',
        message: 'Household list not found.',
      });
    }
    return household;
  }

  /** Household lists as the contract shows them: the parts' rows summed by ingredient, each part's need beside. */
  private async toDtos(households: StoredHousehold[], locale: Locale): Promise<HouseholdList[]> {
    if (households.length === 0) return [];
    const ingredients = await loadIngredients(this.prisma, [
      ...new Set(
        households.flatMap((household) =>
          household.parts.flatMap((part) => part.items.map((item) => item.ingredientId)),
        ),
      ),
    ]);
    const answers: HouseholdList[] = [];
    for (const household of households) {
      const parts = await Promise.all(
        household.parts.map(async (part) => {
          const lines = await planLines(this.prisma, part.planId, part.fromDate, part.toDate);
          return { part, lines, stale: isStale(part, lines, ingredients) };
        }),
      );
      // One kitchen: the days of every part, for the packs of fresh meat and fish.
      const kitchen = parts.flatMap(({ lines }) => lines);
      const rows = new Map<string, { part: StoredPart; item: StoredItem }[]>();
      for (const part of household.parts) {
        for (const item of part.items) {
          const key = `${item.ingredientId}:${item.unit}`;
          rows.set(key, [...(rows.get(key) ?? []), { part, item }]);
        }
      }
      const items: HouseholdListItem[] = [...rows.values()].map((shares) => {
        const item = summed(shares.map((share) => share.item));
        const ingredient = ingredients.get(shares[0]!.item.ingredientId);
        return {
          ...itemDto(item, ingredient, locale, freshOf(item, ingredient, kitchen, household)),
          shares: shares.map(({ part, item: share }) => ({
            profileId: part.plan.profileId,
            profile: part.plan.profile.name,
            totalQuantity: share.totalQuantity,
          })),
        };
      });
      answers.push({
        id: household.id,
        fromDate: isoDate(household.fromDate),
        toDate: isoDate(household.toDate),
        parts: parts.map(({ part, stale }) => ({
          listId: part.id,
          planId: part.planId,
          profileId: part.plan.profileId,
          profile: part.plan.profile.name,
          fromDate: isoDate(part.fromDate),
          toDate: isoDate(part.toDate),
          stale,
        })),
        groups: groupByAisle(items, locale).map((group) => ({
          ...group,
          estimatedCalories: energyOf(group.items),
        })),
        totalEstimatedCalories: energyOf(household.parts.flatMap((part) => part.items)),
        stale: parts.some((part) => part.stale),
        createdAt: household.createdAt.toISOString(),
      });
    }
    return answers;
  }
}

/**
 * The rows of the parts for one ingredient as one row: what they need, have
 * at home and hold, added up; ticked when every one is; the earliest date of
 * what the pantries had. Its id is that of the first part's row.
 */
function summed(items: readonly StoredItem[]): StoredItem {
  const first = items[0]!;
  const dates = items.flatMap((item) => (item.pantryBestBefore ? [item.pantryBestBefore] : []));
  return {
    ...first,
    totalQuantity: clean(items.reduce((sum, item) => sum + item.totalQuantity, 0)),
    alreadyHaveQuantity: clean(items.reduce((sum, item) => sum + item.alreadyHaveQuantity, 0)),
    purchasedQuantity: items.every((item) => item.purchasedQuantity === null)
      ? null
      : clean(items.reduce((sum, item) => sum + (item.purchasedQuantity ?? 0), 0)),
    pantryMoves: [],
    pantryBestBefore:
      dates.length === 0 ? null : new Date(Math.min(...dates.map((date) => date.getTime()))),
    estimatedCalories: items.reduce((sum, item) => sum + item.estimatedCalories, 0),
    checked: items.every((item) => item.checked),
  };
}

const itemNotFound = () =>
  new NotFoundException({ error: 'ITEM_NOT_FOUND', message: 'Shopping list item not found.' });
