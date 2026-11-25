// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The changes of plans' days, as their history tells them ("Historia dnia"). A write of plans (`writePlans`, and the
 * follow of a purchase by weight, `followKitchen`) marks what the days of the kitchens it is of hold before it
 * (`markBefore`), which days its own write changed (`ownDays`), and, once the rests of packs and the freezer followed,
 * keeps an event for each day it changed (`keepEvents`): what made it, whether the user changed that day or a change of
 * other days moved it, the meals it moved as they were and became, and what it did to the lists and the freezer.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  KeptChoice,
  MAX_DAY_EVENTS,
  MealType,
  PlanOptions,
  type DayEventCause,
  type PlanChangeEffects,
} from '@diet-app/shared';
import { levelOf } from '../engine/waste-levels.js';
import {
  isStale,
  loadIngredients,
  planLines,
  type StoredList,
} from '../shopping-lists/shopping-lists.service.js';
import { freezerOf } from './generation-report.js';
import { isoDate, mealNutrition } from './plan-days.js';
import { packsOfPlan } from './plan-packs-store.js';
import { toppingFiguresOf, toppingFoodsOf } from './toppings-store.js';
import { pieced, pieceUsesOf } from './whole-pieces-store.js';

type Tx = Prisma.TransactionClient;

/** A day and one of its meals, or none for a day without meals, with its plan's revision: a row of a read of marks. */
interface MarkRow {
  dayId: string;
  planId: string;
  revision: number;
  date: Date;
  calorieTarget: number;
  overrides: unknown;
  keptChoice: string | null;
  id: string | null;
  mealType: string | null;
  recipeId: string | null;
  source: string | null;
  customName: string | null;
  customMacros: unknown;
  servings: number | null;
  quantityScale: number | null;
  eatenAt: Date | null;
  leftoverFromDate: Date | null;
  toppingKey: string | null;
  toppingAmount: number | null;
  rests: unknown;
  plate: unknown;
  caloriesPerServing: number | null;
  proteinPerServing: number | null;
  fatPerServing: number | null;
  carbsPerServing: number | null;
}

/** A meal as a mark holds it. */
interface MealMark {
  dayId: string;
  mealType: string;
  recipeId: string | null;
  customName: string | null;
  servings: number;
  scale: number;
  eaten: boolean;
  leftover: boolean;
  /** What else makes the meal what it is (its own macros, plate, topping, the rests it finishes): compared, not told. */
  print: string;
  /** What it comes to, its topping with it; null in a mark taken without figures. */
  calories: number | null;
}

/** A day as a mark holds it. */
interface DayMark {
  planId: string;
  date: string;
  target: number;
  overrides: string;
  kept: KeptChoice | null;
}

interface Marks {
  days: Map<string, DayMark>;
  meals: Map<string, MealMark>;
  /** The revision of each plan as the mark was taken. */
  revisions: Map<string, number>;
}

/** What a plan says to take out of the freezer, and to put in it, by the day it says it: what is said, as one string. */
interface FreezerNotes {
  thaw: Map<string, string>;
  freeze: Map<string, string>;
}

/** What the plans of the kitchens of a write hold as it begins (`markBefore`). */
export interface Marked {
  plans: string[];
  kitchen: KitchenPlan[];
  marks: Marks;
  /** The lists of the plans from today on that matched them as the write began: one that no longer does is news. */
  lists: StoredList[];
  freezer: Map<string, FreezerNotes>;
}

/** A plan of a kitchen as the marks read it. */
interface KitchenPlan {
  id: string;
  profileId: string;
  options: unknown;
  report: unknown;
  jointPlanId: string | null;
  userId: string;
  /** A shopping list of the plan reaches today or later. */
  listed: boolean;
}

/** The plans of the kitchens of `planIds`: each of them, and the other plan of a joint plan, in one order. */
async function kitchenPlans(
  tx: Tx,
  planIds: readonly string[],
  today: string,
): Promise<KitchenPlan[]> {
  return tx.$queryRaw<KitchenPlan[]>`
    SELECT plan."id", plan."profileId", plan."options", plan."report", plan."jointPlanId", profile."userId",
      EXISTS (
        SELECT 1 FROM "ShoppingList" AS list
        WHERE list."planId" = plan."id" AND list."toDate" >= ${today}::date
      ) AS "listed"
    FROM "MealPlan" AS plan JOIN "Profile" AS profile ON profile."id" = plan."profileId"
    WHERE plan."id" = ANY(${[...planIds]}::text[])
      OR plan."jointPlanId" IN (
        SELECT "jointPlanId" FROM "MealPlan" WHERE "id" = ANY(${[...planIds]}::text[])
      )
    ORDER BY plan."id"`;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

/** What the days of `planIds` and their meals hold, in one read; with what each meal comes to where `figures`. */
async function marksOf(tx: Tx, planIds: readonly string[], figures: boolean): Promise<Marks> {
  const rows = await tx.$queryRaw<MarkRow[]>`
    SELECT day."id" AS "dayId", day."planId", plan."revision", day."date", day."calorieTarget", day."overrides",
      day."keptChoice", meal."id", meal."mealType", meal."recipeId", meal."source"::text AS "source",
      meal."customName", meal."customMacros", meal."servings", meal."quantityScale", meal."eatenAt",
      meal."leftoverFromDate", meal."toppingKey", meal."toppingAmount", meal."rests", meal."plate",
      recipe."caloriesPerServing", recipe."proteinPerServing", recipe."fatPerServing", recipe."carbsPerServing"
    FROM "MealPlanDay" AS day
    JOIN "MealPlan" AS plan ON plan."id" = day."planId"
    LEFT JOIN "PlannedMeal" AS meal ON meal."dayId" = day."id"
    LEFT JOIN "Recipe" AS recipe ON recipe."id" = meal."recipeId"
    WHERE day."planId" = ANY(${[...planIds]}::text[])`;
  const meals = rows.flatMap((row) =>
    row.id === null
      ? []
      : [
          {
            ...row,
            id: row.id,
            mealType: row.mealType!,
            source: row.source!,
            servings: row.servings!,
            quantityScale: row.quantityScale!,
            recipe:
              row.caloriesPerServing === null
                ? null
                : {
                    caloriesPerServing: row.caloriesPerServing,
                    proteinPerServing: row.proteinPerServing!,
                    fatPerServing: row.fatPerServing!,
                    carbsPerServing: row.carbsPerServing!,
                  },
          },
        ],
  );
  const uses = figures
    ? await pieceUsesOf(
        tx,
        meals.map((meal) => meal.id),
      )
    : new Map();
  const foods =
    figures && meals.some((meal) => meal.toppingKey !== null) ? await toppingFoodsOf(tx) : null;
  const marks: Marks = { days: new Map(), meals: new Map(), revisions: new Map() };
  for (const row of rows) {
    marks.revisions.set(row.planId, row.revision);
    if (marks.days.has(row.dayId)) continue;
    const kept = KeptChoice.safeParse(row.keptChoice);
    marks.days.set(row.dayId, {
      planId: row.planId,
      date: isoDate(row.date),
      target: row.calorieTarget,
      overrides: JSON.stringify(row.overrides ?? null),
      kept: kept.success ? kept.data : null,
    });
  }
  for (const meal of meals) {
    const topping = foods ? (toppingFiguresOf(meal, foods)?.nutrition.calories ?? 0) : 0;
    marks.meals.set(meal.id, {
      dayId: meal.dayId,
      mealType: meal.mealType,
      recipeId: meal.recipeId,
      customName: meal.customName,
      servings: meal.servings,
      scale: meal.quantityScale,
      eaten: meal.eatenAt !== null,
      leftover: meal.leftoverFromDate !== null,
      print: JSON.stringify([
        meal.source,
        meal.customMacros ?? null,
        meal.plate ?? null,
        meal.toppingKey,
        meal.toppingAmount,
        meal.rests ?? null,
      ]),
      calories: figures ? mealNutrition(pieced(meal, uses)).calories + topping : null,
    });
  }
  return marks;
}

/** Whether a meal is as it was: its figures as well where both marks hold them. */
function sameMeal(was: MealMark, now: MealMark): boolean {
  return (
    was.dayId === now.dayId &&
    was.mealType === now.mealType &&
    was.recipeId === now.recipeId &&
    was.customName === now.customName &&
    near(was.servings, now.servings) &&
    near(was.scale, now.scale) &&
    was.eaten === now.eaten &&
    was.leftover === now.leftover &&
    was.print === now.print &&
    (was.calories === null || now.calories === null || was.calories === now.calories)
  );
}

function sameDay(was: DayMark, now: DayMark): boolean {
  return was.target === now.target && was.overrides === now.overrides && was.kept === now.kept;
}

/** The days whose meals or settings differ between two marks. */
function changedDays(was: Marks, now: Marks): Set<string> {
  const changed = new Set<string>();
  for (const [dayId, day] of now.days) {
    const before = was.days.get(dayId);
    if (!before || !sameDay(before, day)) changed.add(dayId);
  }
  for (const [mealId, meal] of now.meals) {
    const before = was.meals.get(mealId);
    if (!before) changed.add(meal.dayId);
    else if (!sameMeal(before, meal)) {
      changed.add(meal.dayId);
      changed.add(before.dayId);
    }
  }
  for (const [mealId, meal] of was.meals) if (!now.meals.has(mealId)) changed.add(meal.dayId);
  return changed;
}

/** The lists of `plans` from today on that match their plans now. */
async function matchingLists(
  tx: Tx,
  plans: readonly string[],
  today: string,
): Promise<StoredList[]> {
  const lists: StoredList[] = await tx.shoppingList.findMany({
    where: { planId: { in: [...plans] }, toDate: { gte: new Date(today) } },
    include: { items: true },
  });
  const stale = await staleNow(tx, lists);
  return lists.filter((list) => !stale.has(list.id));
}

/** Which of `lists` no longer match their plans as they are now (`isStale`), by id: one read of each plan's lines. */
async function staleNow(tx: Tx, lists: readonly StoredList[]): Promise<Set<string>> {
  const stale = new Set<string>();
  if (lists.length === 0) return stale;
  const ingredients = await loadIngredients(tx, [
    ...new Set(lists.flatMap((list) => list.items.map((item) => item.ingredientId))),
  ]);
  for (const planId of new Set(lists.map((list) => list.planId))) {
    const own = lists.filter((list) => list.planId === planId);
    const lines = await planLines(
      tx,
      planId,
      new Date(Math.min(...own.map((list) => list.fromDate.getTime()))),
      new Date(Math.max(...own.map((list) => list.toDate.getTime()))),
    );
    // As the list's page tells it (`ShoppingListsService`): against the ingredients of the lists read with it.
    for (const list of own) if (isStale(list, lines, ingredients)) stale.add(list.id);
  }
  return stale;
}

/**
 * What a plan says to take out of the freezer and to put in it, by the day it says it (as the plan's days show it:
 * a portion comes out the day before the meal that takes it, or on the day where that is gone or no day of the plan);
 * null for a plan that neither freezes, nor was made with something in the freezer, nor shares its kitchen.
 */
async function freezerNotesOf(
  tx: Tx,
  plan: KitchenPlan,
  dates: readonly string[],
  today: string,
  /** What the plan takes out of the freezer was chosen again since `plan` was read. */
  chosenAgain: boolean,
): Promise<FreezerNotes | null> {
  const options = PlanOptions.safeParse(plan.options);
  if (
    !chosenAgain &&
    !(options.success && levelOf(options.data)?.freezes) &&
    !freezerOf(plan.report) &&
    !plan.jointPlanId
  )
    return null;
  const packs = await packsOfPlan(tx, plan.userId, plan.id, 'en');
  if (!packs) return null;
  const said = (into: Map<string, string[]>, date: string, what: string): void => {
    into.set(date, [...(into.get(date) ?? []), what]);
  };
  const thaw = new Map<string, string[]>();
  const freeze = new Map<string, string[]>();
  for (const held of [
    ...packs.fromFreezer.map((one) => ({ ...one, thawed: [one] })),
    ...packs.frozen,
  ])
    for (const taken of held.thawed) {
      const at = dates.indexOf(taken.date);
      if (at < 0) continue;
      const before = at > 0 ? dates[at - 1]! : null;
      said(
        thaw,
        before !== null && before >= today ? before : taken.date,
        `${held.ingredientId} ${taken.amount} ${taken.date} ${taken.mealId ?? ''}`,
      );
    }
  for (const rest of packs.frozen)
    said(
      freeze,
      rest.date,
      `${rest.ingredientId} ${rest.amount} ${rest.left} ${rest.thawed.map((one) => `${one.date}:${one.amount}`).join(',')}`,
    );
  const joined = (by: Map<string, string[]>) =>
    new Map([...by].map(([date, lines]) => [date, lines.sort().join(';')]));
  return { thaw: joined(thaw), freeze: joined(freeze) };
}

/** The dates of a plan's days, in order, by plan. */
function datesByPlan(marks: Marks): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const day of marks.days.values())
    by.set(day.planId, [...(by.get(day.planId) ?? []), day.date]);
  for (const dates of by.values()) dates.sort();
  return by;
}

async function freezerOfPlans(
  tx: Tx,
  plans: readonly KitchenPlan[],
  marks: Marks,
  today: string,
  chosenAgain: ReadonlySet<string> = new Set(),
): Promise<Map<string, FreezerNotes>> {
  const dates = datesByPlan(marks);
  const notes = new Map<string, FreezerNotes>();
  for (const plan of plans) {
    const said = await freezerNotesOf(
      tx,
      plan,
      dates.get(plan.id) ?? [],
      today,
      chosenAgain.has(plan.id),
    );
    if (said) notes.set(plan.id, said);
  }
  return notes;
}

/** What the plans of the kitchens of `planIds` hold as a write of them begins: what its events are told against. */
export async function markBefore(
  tx: Tx,
  planIds: readonly string[],
  today: string,
): Promise<Marked> {
  const plans = await kitchenPlans(tx, planIds, today);
  const ids = plans.map((plan) => plan.id);
  const marks = await marksOf(tx, ids, true);
  const listed = plans.filter((plan) => plan.listed).map((plan) => plan.id);
  return {
    plans: ids,
    kitchen: plans,
    marks,
    lists: listed.length > 0 ? await matchingLists(tx, listed, today) : [],
    freezer: await freezerOfPlans(tx, plans, marks, today),
  };
}

/** The days the write itself changed, before the rests of packs and the freezer followed it: the user's own change. */
export async function ownDays(tx: Tx, marked: Marked): Promise<Set<string>> {
  return changedDays(marked.marks, await marksOf(tx, marked.plans, false));
}

/** The dates that hold another note in `now` than in `was`, from today on. */
function changedNotes(
  was: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
  today: string,
): string[] {
  return [...new Set([...was.keys(), ...now.keys()])].filter(
    (date) => date >= today && was.get(date) !== now.get(date),
  );
}

/** A meal as an event keeps it: its recipe or its own name (told in the reader's language), servings and figures. */
interface StoredMealState {
  recipeId: string | null;
  customName: string | null;
  servings: number;
  scale: number;
  calories: number;
  eaten: boolean;
  leftover: boolean;
}

/** A meal an event moved, as it keeps it (`PlanDayEvent.changes`). */
export interface StoredEventMeal {
  mealId: string;
  mealType: string;
  before: StoredMealState | null;
  after: StoredMealState | null;
}

/** What an event keeps in `PlanDayEvent.changes`. */
export interface StoredEventChanges {
  meals: StoredEventMeal[];
  target: { before: number; after: number } | null;
  choice: { before: KeptChoice | null; after: KeptChoice | null } | null;
}

function stateOf(meal: MealMark): StoredMealState {
  return {
    recipeId: meal.recipeId,
    customName: meal.customName,
    servings: meal.servings * meal.scale,
    scale: meal.scale,
    calories: meal.calories ?? 0,
    eaten: meal.eaten,
    leftover: meal.leftover,
  };
}

const typeOrder = (mealType: string): number => {
  const at = (MealType.options as readonly string[]).indexOf(mealType);
  return at < 0 ? MealType.options.length : at;
};

/** The meals of a day a change moved, a meal it took off paired with one it put in at the same time of day. */
function movedMeals(dayId: string, was: Marks, now: Marks): StoredEventMeal[] {
  const of = (marks: Marks) => [...marks.meals].filter(([, meal]) => meal.dayId === dayId);
  const before = new Map(of(was));
  const after = new Map(of(now));
  const moved: StoredEventMeal[] = [];
  const gone: [string, MealMark][] = [];
  for (const [mealId, meal] of before) {
    const then = after.get(mealId);
    if (!then) gone.push([mealId, meal]);
    else if (!sameMeal(meal, then))
      moved.push({
        mealId,
        mealType: then.mealType,
        before: stateOf(meal),
        after: stateOf(then),
      });
  }
  for (const [mealId, meal] of after) {
    if (before.has(mealId)) continue;
    const place = gone.findIndex(([, left]) => left.mealType === meal.mealType);
    const left = place >= 0 ? gone.splice(place, 1)[0]![1] : null;
    moved.push({
      mealId,
      mealType: meal.mealType,
      before: left ? stateOf(left) : null,
      after: stateOf(meal),
    });
  }
  for (const [mealId, meal] of gone)
    moved.push({ mealId, mealType: meal.mealType, before: stateOf(meal), after: null });
  return moved.sort((a, b) => typeOrder(a.mealType) - typeOrder(b.mealType));
}

/**
 * Keep an event for each day of the kitchens of `marked` the write changed: `own` the days its own write changed
 * (`ownDays`), the rest moved by it through the rests of packs, with the dates of the days it was of. Each carries
 * what the write did to the lists that matched their plans as it began, and to the freezer's notes from today on, and
 * its plan's revision as the write leaves it. A day keeps its latest `MAX_DAY_EVENTS`.
 */
export async function keepEvents(
  tx: Tx,
  marked: Marked,
  own: ReadonlySet<string>,
  cause: DayEventCause,
  today: string,
  /** The plans whose choice of what to take out of the freezer the write changed (`repickFreezer`). */
  chosenAgain: ReadonlySet<string>,
): Promise<void> {
  const now = await marksOf(tx, marked.plans, true);
  const changed = changedDays(marked.marks, now);
  if (changed.size === 0) return;

  const stale = await staleNow(tx, marked.lists);
  const lists: PlanChangeEffects['lists'] = marked.lists
    .filter((list) => stale.has(list.id))
    .map((list) => ({
      id: list.id,
      planId: list.planId,
      profileId: marked.kitchen.find((plan) => plan.id === list.planId)!.profileId,
      fromDate: isoDate(list.fromDate),
      toDate: isoDate(list.toDate),
      householdId: list.householdId,
    }));
  const plans = marked.kitchen;
  const notes = await freezerOfPlans(tx, plans, now, today, chosenAgain);
  const thaw = new Set<string>();
  const freeze = new Set<string>();
  for (const plan of plans) {
    const was = marked.freezer.get(plan.id);
    const is = notes.get(plan.id);
    if (!was && !is) continue;
    const none = new Map<string, string>();
    for (const date of changedNotes(was?.thaw ?? none, is?.thaw ?? none, today)) thaw.add(date);
    for (const date of changedNotes(was?.freeze ?? none, is?.freeze ?? none, today))
      freeze.add(date);
  }
  const effects: PlanChangeEffects = {
    lists: lists.sort((a, b) => a.fromDate.localeCompare(b.fromDate)),
    thaw: [...thaw].sort(),
    freeze: [...freeze].sort(),
  };

  const from = [...own]
    .filter((dayId) => changed.has(dayId))
    .map((dayId) => now.days.get(dayId)!.date)
    .sort();
  const change = randomUUID();
  const days = [...changed].filter((dayId) => now.days.has(dayId));
  const rows = days.map((dayId) => {
    const was = marked.marks.days.get(dayId);
    const is = now.days.get(dayId)!;
    const changes: StoredEventChanges = {
      meals: movedMeals(dayId, marked.marks, now),
      target: was && was.target !== is.target ? { before: was.target, after: is.target } : null,
      choice: was && was.kept !== is.kept ? { before: was.kept, after: is.kept } : null,
    };
    const mine = own.has(dayId);
    return Prisma.sql`(${randomUUID()}, ${dayId}, ${change}, ${cause}, ${mine},
      ${mine ? null : JSON.stringify({ from })}::jsonb, ${JSON.stringify(changes)}::jsonb,
      ${JSON.stringify(effects)}::jsonb, ${now.revisions.get(is.planId) ?? 0})`;
  });
  // A day keeps its latest changes, by its plan's revisions, the latest first: of those it held, one fewer than it
  // keeps stay, and the change written now is the one more. The removal reads the table as it was before the write.
  await tx.$executeRaw`
    WITH "gone" AS (
      DELETE FROM "PlanDayEvent" WHERE "id" IN (
        SELECT "id" FROM (
          SELECT "id", row_number() OVER (
            PARTITION BY "dayId" ORDER BY "revision" DESC, "at" DESC, "id" DESC
          ) AS "place"
          FROM "PlanDayEvent" WHERE "dayId" = ANY(${days}::text[])
        ) AS "ranked" WHERE "place" >= ${MAX_DAY_EVENTS}
      )
    )
    INSERT INTO "PlanDayEvent" ("id", "dayId", "change", "cause", "own", "detail", "changes", "effects", "revision")
    VALUES ${Prisma.join(rows)}`;
}
