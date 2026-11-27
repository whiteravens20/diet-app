// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the plans of a kitchen take out of the freezer, chosen again after a change of one of them. A plan chooses its
 * packages when it is made (`StoredReport.freezer`); a change of its menu afterwards (a meal of one's own, other
 * portions, a swap, a day made again, a day's settings) can make a day eat whole a package it left frozen, or leave
 * one it took. Chosen again from tomorrow on, the plan takes what its menu now eats whole, as it would if it were made
 * now, and keeps every package it had said to take out by today, before the change.
 */
import type { Prisma } from '@prisma/client';
import { PlanOptions } from '@diet-app/shared';
import { isDueSoon, packagesTaken, thawAll } from '../engine/packs.js';
import { frozenPackages, goingOffFirst, readMoves } from '../inventory/pantry-store.js';
import { freezerOf, StoredReport, type Freezer } from './generation-report.js';
import { isoDate } from './plan-days.js';
import { menuNeeds, onDaysOf } from './plan-menu.js';
import { MEAL_ROW, packedOfDays } from './plan-packs-store.js';

type Tx = Prisma.TransactionClient;

/** A package of a kitchen's freezer, as the choice of what its plans take out reads it. */
export interface KitchenPackage {
  /** The plan of the kitchen whose profile's freezer holds it. */
  planId: string;
  ingredientId: string;
  parcel: number;
  /** What it holds, in its food's canonical unit. */
  amount: number;
  bestBefore: string | null;
  /** The first day it may be eaten from, by its place among the plan's days. */
  from: number;
  /** The plan takes it out as it keeps its freezer. */
  taken: boolean;
  /** It is still in the profile's freezer: not taken out yet, nor taken by a shopping list. */
  held: boolean;
  /** Taken out of the freezer by a shopping list of its plan: gone from the freezer, and still the plan's. */
  byList: boolean;
}

/** A package as `said` names it: its plan, its food and its number. */
export const packageKey = (
  one: Pick<KitchenPackage, 'planId' | 'ingredientId' | 'parcel'>,
): string => `${one.planId}:${one.ingredientId}:${one.parcel}`;

/**
 * The packages taken out (`taken`) that the menu `needs` eats first on or before the day at `tomorrow`, by
 * `packageKey`: the plan says to take each of them out by today.
 */
export function packagesDue(
  needs: ReadonlyMap<string, readonly number[]>,
  packages: readonly KitchenPackage[],
  tomorrow: number,
): Set<string> {
  const due = new Set<string>();
  if (tomorrow < 0) return due;
  for (const ingredientId of new Set(packages.map((one) => one.ingredientId))) {
    const row = needs.get(ingredientId);
    if (!row) continue;
    const taken = packages
      .filter((one) => one.taken && one.ingredientId === ingredientId)
      .sort(goingOffFirst);
    const { thawed } = thawAll(
      row,
      taken.map((one) => ({ amount: one.amount, from: one.from })),
    );
    taken.forEach((one, at) => {
      const first = thawed[at];
      if (first && first.day <= tomorrow) due.add(packageKey(one));
    });
  }
  return due;
}

/**
 * The packages the plans of a kitchen take out, chosen again from the day at `tomorrow` (its place among the plan's
 * days, below 0 for a plan with no day after today): a package taken already stays where the plan said to take it out
 * by today (`said`, before the change), where the menu now eats it first by tomorrow, and where it is no longer in the
 * freezer; every other package is taken where the days from tomorrow on eat it whole within the days it keeps thawed,
 * or it is dated soon (`packagesTaken`), the one going off first first, after those that stay. Answers the packages
 * taken, one taken anew eaten from tomorrow on.
 */
export function chooseAgain(
  needs: ReadonlyMap<string, readonly number[]>,
  packages: readonly KitchenPackage[],
  tomorrow: number,
  lastDay: string,
  said: ReadonlySet<string>,
): KitchenPackage[] {
  const due = packagesDue(needs, packages, tomorrow);
  const chosen: KitchenPackage[] = [];
  for (const ingredientId of new Set(packages.map((one) => one.ingredientId))) {
    const row = needs.get(ingredientId);
    const ofFood = packages.filter((one) => one.ingredientId === ingredientId);
    // A package gone from the freezer stays the plan's where its list took it or it was to come out by today; one
    // gone before then any other way was removed from the freezer by hand, and the plan takes another or buys fresh.
    const kept = ofFood
      .filter(
        (one) =>
          one.taken &&
          ((!one.held && one.byList) ||
            tomorrow < 0 ||
            said.has(packageKey(one)) ||
            due.has(packageKey(one))),
      )
      .sort(goingOffFirst);
    chosen.push(...kept);
    if (!row || tomorrow < 0) continue;
    const { rest } = thawAll(
      row,
      kept.map((one) => ({ amount: one.amount, from: one.from })),
    );
    const free = ofFood.filter((one) => one.held && !kept.includes(one)).sort(goingOffFirst);
    const picked = packagesTaken(
      rest,
      free.map((one) => ({
        amount: one.amount,
        from: tomorrow,
        due: isDueSoon(one.bestBefore, lastDay),
      })),
    );
    chosen.push(
      ...picked.map((at) => ({
        ...free[at]!,
        taken: true,
        from: Math.max(free[at]!.from, tomorrow),
      })),
    );
  }
  return chosen;
}

/** A plan of a kitchen as it is first read: whether there is anything to choose for it at all. */
const LIGHT_PLAN = {
  id: true,
  options: true,
  report: true,
  jointPlanId: true,
  profile: { select: { _count: { select: { inventory: { where: { frozen: true } } } } } },
} as const;

/**
 * The plans of the kitchen of the plan `planId`, read lightly, and whether any of them that counts the pantry takes
 * a package out (`taken`) or has one in its profile's freezer (`frozen`): a plan with neither has nothing to choose.
 */
async function lightKitchen(
  tx: Tx,
  planId: string,
): Promise<{ ids: string[]; taken: boolean; frozen: boolean }> {
  const own = await tx.mealPlan.findUnique({ where: { id: planId }, select: LIGHT_PLAN });
  if (!own) return { ids: [], taken: false, frozen: false };
  const partner = own.jointPlanId
    ? await tx.mealPlan.findFirst({
        where: { jointPlanId: own.jointPlanId, id: { not: own.id } },
        select: LIGHT_PLAN,
      })
    : null;
  const plans = partner ? [own, partner] : [own];
  const counting = plans.filter((plan) => {
    const made = PlanOptions.parse(plan.options);
    return made.respectInventory || made.lessWaste;
  });
  return {
    ids: plans.map((plan) => plan.id),
    taken: counting.some((plan) => (freezerOf(plan.report)?.stock.size ?? 0) > 0),
    frozen: counting.some((plan) => (plan.profile?._count.inventory ?? 0) > 0),
  };
}

/** A plan of a kitchen, as its freezer is chosen again. */
const KITCHEN_PLAN = {
  id: true,
  profileId: true,
  createdAt: true,
  options: true,
  report: true,
  jointPlanId: true,
  days: { orderBy: { date: 'asc' }, select: { date: true, meals: { select: MEAL_ROW } } },
} as const;

type KitchenPlan = Prisma.MealPlanGetPayload<{ select: typeof KITCHEN_PLAN }>;

/** What the choice of a kitchen's freezer reads of it. */
interface Kitchen {
  own: KitchenPlan;
  partner: KitchenPlan | null;
  /** Its plans that count the pantry, and so take out of the freezer. */
  counting: KitchenPlan[];
  /** The first plan's days. */
  dates: string[];
  /** The place of the first day after today among them, below 0 where none is. */
  tomorrow: number;
  /** Each counting plan's freezer as it keeps it. */
  kept: Map<string, Freezer | null>;
  packages: KitchenPackage[];
}

/**
 * The kitchen of the plan `planId`, today being `today`: its plans, and the packages of the freezers of those that
 * count the pantry, those taken and those that were in the freezer when the plan was made; null where there is no
 * package to choose.
 */
async function kitchenOf(tx: Tx, planId: string, today: string): Promise<Kitchen | null> {
  const own = await tx.mealPlan.findUnique({ where: { id: planId }, select: KITCHEN_PLAN });
  if (!own) return null;
  const partner = own.jointPlanId
    ? await tx.mealPlan.findFirst({
        where: { jointPlanId: own.jointPlanId, id: { not: own.id } },
        select: KITCHEN_PLAN,
      })
    : null;
  const dates = own.days.map((day) => isoDate(day.date));
  // A plan takes out of the freezer where it counts the pantry, as it was made (`countsPantry`).
  const counting = (partner ? [own, partner] : [own]).filter((plan) => {
    const made = PlanOptions.parse(plan.options);
    return made.respectInventory || made.lessWaste;
  });
  if (dates.length === 0 || counting.length === 0) return null;
  const tomorrow = dates.findIndex((date) => date > today);

  const kept = new Map<string, Freezer | null>();
  const packages: KitchenPackage[] = [];
  for (const plan of counting) {
    const freezer = freezerOf(plan.report);
    kept.set(plan.id, freezer);
    const now = await frozenPackages(tx, plan.profileId);
    const keptFrom = freezer ? dates.findIndex((date) => date >= freezer.from) : -1;
    for (const [ingredientId, list] of freezer?.stock ?? []) {
      for (const one of list) {
        const from = one.from ? dates.findIndex((date) => date >= one.from!) : keptFrom;
        packages.push({
          planId: plan.id,
          ingredientId,
          parcel: one.parcel,
          amount: one.amount,
          bestBefore: one.bestBefore,
          from: from < 0 ? dates.length : from,
          taken: true,
          held: now.get(ingredientId)?.some((held) => held.parcel === one.parcel) ?? false,
          byList: false,
        });
      }
    }
    for (const [ingredientId, list] of now) {
      for (const one of list) {
        // Frozen after the plan was made: no part of the freezer it takes out of.
        if (one.frozenAt > plan.createdAt) continue;
        if (freezer?.stock.get(ingredientId)?.some((taken) => taken.parcel === one.parcel))
          continue;
        packages.push({
          planId: plan.id,
          ingredientId,
          parcel: one.parcel,
          amount: one.amount,
          bestBefore: one.bestBefore,
          from: Math.max(0, tomorrow),
          taken: false,
          held: true,
          byList: false,
        });
      }
    }
  }
  if (packages.length === 0) return null;
  // A package taken that the freezer no longer holds: read only then, whether a list of its plan took it.
  const gone = packages.filter((one) => one.taken && !one.held);
  if (gone.length > 0) {
    const took = await packagesListsTook(
      tx,
      counting.map((plan) => plan.id),
    );
    for (const one of gone)
      one.byList = took.has(`${one.planId}:${one.ingredientId}:${one.parcel}`);
  }
  return { own, partner, counting, dates, tomorrow, kept, packages };
}

/** A package a shopping list took out of the freezer for its plan: gone from the pantry, still in the freezer. */
export interface ListTook {
  planId: string;
  ingredientId: string;
  parcel: number;
  /** What it took, in the package's own unit. */
  quantity: number;
  unit: string;
}

/** What the shopping lists of the plans `planIds` took out of the freezer for them, package by package. */
export async function listsTookFromFreezer(
  db: Pick<Tx, 'shoppingListItem'>,
  planIds: readonly string[],
): Promise<ListTook[]> {
  const rows = await db.shoppingListItem.findMany({
    where: { list: { planId: { in: [...planIds] } } },
    select: { ingredientId: true, pantryMoves: true, list: { select: { planId: true } } },
  });
  return rows.flatMap((row) =>
    readMoves(row.pantryMoves)
      .filter((move) => move.frozen)
      .map((move) => ({
        planId: row.list.planId,
        ingredientId: row.ingredientId,
        parcel: move.parcel ?? 0,
        quantity: move.quantity,
        unit: move.unit,
      })),
  );
}

/** The packages the shopping lists of the plans `planIds` took out of the freezer, as `planId:ingredientId:parcel`. */
async function packagesListsTook(tx: Tx, planIds: readonly string[]): Promise<Set<string>> {
  return new Set(
    (await listsTookFromFreezer(tx, planIds)).map(
      (one) => `${one.planId}:${one.ingredientId}:${one.parcel}`,
    ),
  );
}

/** What the kitchen's menu takes of each food in packs, day by day: the other plan's meals on the first plan's days. */
async function needsOf(tx: Tx, kitchen: Kitchen): Promise<Map<string, number[]>> {
  const { own, partner, dates } = kitchen;
  const meals = [
    ...(await packedOfDays(tx, own.days, PlanOptions.parse(own.options).mealPrepFriendly)),
    ...(partner
      ? onDaysOf(
          await packedOfDays(tx, partner.days, PlanOptions.parse(partner.options).mealPrepFriendly),
          partner.days.map((day) => isoDate(day.date)),
          dates,
        )
      : []),
  ];
  return menuNeeds(meals, dates.length).needs;
}

/**
 * The packages of the freezer the kitchen of the plan `planId` says to take out by `today`, on the menu as it stands
 * (`packagesDue`): read before a change, so that the choice after it keeps them (`repickFreezer`).
 */
export async function packagesSaid(tx: Tx, planId: string, today: string): Promise<Set<string>> {
  if (!(await lightKitchen(tx, planId)).taken) return new Set();
  const kitchen = await kitchenOf(tx, planId, today);
  if (!kitchen || !kitchen.packages.some((one) => one.taken)) return new Set();
  return packagesDue(await needsOf(tx, kitchen), kitchen.packages, kitchen.tomorrow);
}

/**
 * Choose again what the plans of the kitchen of the plan `planId` take out of the freezer (`chooseAgain`), today being
 * `today` and `said` what they said to take out by today before the change (`packagesSaid`), and keep the choice with
 * each plan that counts the pantry, as a plan made then would have chosen: of the packages that were in its profile's
 * freezer when it was made. A package frozen later stays out of it, as the plan says (`PlanPacks.staysFrozen`).
 * Answers the plans of the kitchen, and those whose choice changed.
 */
export async function repickFreezer(
  tx: Tx,
  planId: string,
  today: string,
  said: ReadonlySet<string>,
): Promise<{ kitchen: string[]; changed: string[] }> {
  const light = await lightKitchen(tx, planId);
  const kitchen = light.taken || light.frozen ? await kitchenOf(tx, planId, today) : null;
  if (!kitchen) return { kitchen: light.ids, changed: [] };
  const { counting, dates, tomorrow, kept, packages } = kitchen;
  const chosen = chooseAgain(await needsOf(tx, kitchen), packages, tomorrow, dates.at(-1)!, said);

  const changed: string[] = [];
  for (const plan of counting) {
    const before = kept.get(plan.id) ?? null;
    const from = before?.from ?? dates[Math.max(0, tomorrow)]!;
    const stock = chosen
      .filter((one) => one.planId === plan.id)
      .map((one) => {
        const first = dates[one.from];
        return {
          ingredientId: one.ingredientId,
          amount: one.amount,
          parcel: one.parcel,
          bestBefore: one.bestBefore,
          ...(first !== undefined && first > from ? { from: first } : {}),
        };
      });
    if (sameStock(before, stock)) continue;
    // A plan from before reports were kept has no freezer to keep.
    const report = StoredReport.safeParse(plan.report);
    if (!report.success) continue;
    await tx.mealPlan.update({
      where: { id: plan.id },
      data: { report: { ...report.data, freezer: stock.length > 0 ? { from, stock } : null } },
    });
    changed.push(plan.id);
  }
  return { kitchen: light.ids, changed };
}

/** Whether a plan's freezer as it keeps it holds the packages of `stock`, each the same amount from the same day. */
function sameStock(
  before: Freezer | null,
  stock: readonly { ingredientId: string; amount: number; parcel: number; from?: string }[],
): boolean {
  const key = (one: { ingredientId: string; amount: number; parcel: number; from?: string }) =>
    `${one.ingredientId}:${one.parcel}:${Math.round(one.amount * 10)}:${one.from ?? ''}`;
  const had = [...(before?.stock ?? [])].flatMap(([ingredientId, list]) =>
    list.map((one) => key({ ...one, ingredientId })),
  );
  return had.sort().join('|') === stock.map(key).sort().join('|');
}

/**
 * Choose again what every plan of the profile `profileId` with a day after `today` takes out of the freezer, after a
 * write of a frozen row of its pantry by hand (`repickFreezer`): a package that left the freezer before it was to
 * come out, and that no list of its plan took, leaves the plan, which takes another or buys fresh. Answers the plans
 * whose choice changed.
 */
export async function repickProfile(tx: Tx, profileId: string, today: string): Promise<string[]> {
  const plans = await tx.mealPlan.findMany({
    where: { profileId, days: { some: { date: { gt: new Date(today) } } } },
    orderBy: { startDate: 'asc' },
    select: { id: true },
  });
  const changed: string[] = [];
  for (const plan of plans) {
    const said = await packagesSaid(tx, plan.id, today);
    changed.push(...(await repickFreezer(tx, plan.id, today, said)).changed);
  }
  return changed;
}
