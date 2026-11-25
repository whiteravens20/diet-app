// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A day of a plan and its changes ("Historia dnia"), as `GET /meal-plans/:id/days/:dayId/history` answers it: what
 * holds the day, the changes its writes kept (`keepEvents`), told in the reader's language, and the undo of the last of
 * them where nothing changed the plan after it.
 */
import type { Prisma } from '@prisma/client';
import {
  DayEventCause,
  KeptChoice,
  MAX_DAY_EVENTS,
  MealType,
  PlanChangeEffects,
  type DayEvent,
  type DayEventMealState,
  type DayEventUndo,
  type DayHistory,
  type Locale,
} from '@diet-app/shared';
import type { StoredEventChanges, StoredEventMeal } from './day-events.js';
import { isoDate, restsOf } from './plan-days.js';

type Db = Pick<
  Prisma.TransactionClient,
  | 'mealPlanDay'
  | 'planDayEvent'
  | 'recipeTranslation'
  | 'ingredientTranslation'
  | 'diaryEntry'
  | 'mealPlan'
>;

/** Causes whose change is itself an undo, or moves no portion: their undo is not offered. */
const NOT_UNDONE: ReadonlySet<DayEventCause> = new Set([
  'undo',
  'swap-undo',
  'kept',
  'leftover-undo',
]);

/** Causes taken back by the swap's own undo (`UndoSwapRequest`), while the plan stands as the swap left it. */
const SWAPS: ReadonlySet<DayEventCause> = new Set(['swap', 'ingredient-swap']);

const EMPTY_EFFECTS: PlanChangeEffects = { lists: [], thaw: [], freeze: [] };

/** A name in the reader's language: theirs, else English, else none. */
function named(
  rows: readonly { locale: string; name: string }[],
  locale: Locale,
): string | undefined {
  return (rows.find((row) => row.locale === locale) ?? rows.find((row) => row.locale === 'en'))
    ?.name;
}

/** The titles of the recipes `ids` in the reader's language. */
async function titlesOf(
  db: Db,
  ids: readonly string[],
  locale: Locale,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.recipeTranslation.findMany({
    where: { recipeId: { in: [...ids] }, locale: { in: [locale, 'en'] } },
    select: { recipeId: true, locale: true, title: true },
  });
  const titles = new Map<string, string>();
  for (const id of new Set(ids)) {
    const title = named(
      rows
        .filter((row) => row.recipeId === id)
        .map((row) => ({ locale: row.locale, name: row.title })),
      locale,
    );
    if (title) titles.set(id, title);
  }
  return titles;
}

/** Whether a change of a meal moved its portion alone: the same dish, eaten or not as it was. */
function portionOnly(meal: StoredEventMeal): boolean {
  const { before, after } = meal;
  return (
    before !== null &&
    after !== null &&
    before.recipeId === after.recipeId &&
    before.customName === after.customName &&
    before.eaten === after.eaten &&
    before.leftover === after.leftover
  );
}

/**
 * The day `dayId` of the plan `planId` of `userId` and its changes, the latest first; null where the plan or the day
 * is not theirs.
 */
export async function dayHistoryOf(
  db: Db,
  userId: string,
  planId: string,
  dayId: string,
  locale: Locale,
): Promise<DayHistory | null> {
  const day = await db.mealPlanDay.findFirst({
    where: { id: dayId, planId, plan: { profile: { userId } } },
    select: {
      id: true,
      date: true,
      keptChoice: true,
      keptAt: true,
      plan: { select: { revision: true, lastSwap: true, profileId: true } },
      meals: {
        select: {
          recipeId: true,
          source: true,
          customName: true,
          eatenAt: true,
          leftoverFromDate: true,
          rests: true,
        },
      },
    },
  });
  if (!day) return null;
  const rows = await db.planDayEvent.findMany({
    where: { dayId },
    orderBy: [{ revision: 'desc' }, { at: 'desc' }, { id: 'desc' }],
    take: MAX_DAY_EVENTS,
  });
  const stored = rows.map((row) => ({
    row,
    changes: row.changes as unknown as StoredEventChanges,
  }));
  const recipeIds = [
    ...day.meals.flatMap((meal) => (meal.recipeId ? [meal.recipeId] : [])),
    ...stored.flatMap(({ changes }) =>
      changes.meals.flatMap((meal) =>
        [meal.before?.recipeId, meal.after?.recipeId].filter((id): id is string => !!id),
      ),
    ),
  ];
  const titles = await titlesOf(db, recipeIds, locale);
  const nameOf = (meal: { recipeId: string | null; customName: string | null }): string | null =>
    meal.customName ?? (meal.recipeId ? (titles.get(meal.recipeId) ?? null) : null);

  // What no sizing of the day moves.
  const restFoods = [
    ...new Set(day.meals.flatMap((meal) => restsOf(meal.rests).map((rest) => rest.ingredientId))),
  ];
  const foods = restFoods.length
    ? await db.ingredientTranslation.findMany({
        where: { ingredientId: { in: restFoods }, locale: { in: [locale, 'en'] } },
        select: { ingredientId: true, locale: true, name: true },
      })
    : [];
  const entries = await db.diaryEntry.count({
    where: { profileId: day.plan.profileId, date: day.date },
  });
  const names = (meals: typeof day.meals) =>
    meals.map((meal) => nameOf(meal)).filter((name): name is string => name !== null);
  const kept = KeptChoice.safeParse(day.keptChoice);

  const state = (meal: StoredEventMeal['before']): DayEventMealState | null =>
    meal && {
      name: nameOf(meal),
      servings: meal.servings,
      calories: Math.round(meal.calories),
      eaten: meal.eaten,
      leftover: meal.leftover,
    };
  const events: DayEvent[] = stored.flatMap(({ row, changes }) => {
    const cause = DayEventCause.safeParse(row.cause);
    if (!cause.success) return [];
    const effects = PlanChangeEffects.safeParse(row.effects);
    const detail = row.detail as { from?: unknown } | null;
    return [
      {
        id: row.id,
        at: row.at.toISOString(),
        cause: cause.data,
        own: row.own,
        from: Array.isArray(detail?.from) ? (detail.from as string[]) : [],
        meals: changes.meals.flatMap((meal) => {
          const mealType = MealType.safeParse(meal.mealType);
          return mealType.success
            ? [
                {
                  mealId: meal.mealId,
                  mealType: mealType.data,
                  before: state(meal.before),
                  after: state(meal.after),
                },
              ]
            : [];
        }),
        target: changes.target,
        choice: changes.choice,
        effects: effects.success ? effects.data : EMPTY_EFFECTS,
      },
    ];
  });

  return {
    planId,
    dayId,
    date: isoDate(day.date),
    revision: day.plan.revision,
    kept: kept.success && day.keptAt ? { choice: kept.data, at: day.keptAt.toISOString() } : null,
    holds: {
      ownMeals: names(day.meals.filter((meal) => meal.source === 'USER_CUSTOM')),
      eatenMeals: names(day.meals.filter((meal) => meal.eatenAt !== null)),
      leftovers: names(day.meals.filter((meal) => meal.leftoverFromDate !== null)),
      rests: restFoods
        .map((id) =>
          named(
            foods.filter((food) => food.ingredientId === id),
            locale,
          ),
        )
        .filter((name): name is string => name !== undefined),
      diaryEntries: entries,
    },
    events,
    undo: await undoOf(db, planId, dayId, day.plan, stored[0] ?? null),
  };
}

/**
 * The undo of the day's last change, where it is offered: while the plan stands at the revision the change left it at,
 * a swap by its own undo, a change of portions alone, of this plan's days only, by putting them back.
 */
async function undoOf(
  db: Db,
  planId: string,
  dayId: string,
  plan: { revision: number; lastSwap: Prisma.JsonValue },
  last: { row: { id: string; change: string; cause: string; revision: number } } | null,
): Promise<DayEventUndo | null> {
  if (!last || last.row.revision !== plan.revision) return null;
  const cause = DayEventCause.safeParse(last.row.cause);
  if (!cause.success || NOT_UNDONE.has(cause.data)) return null;
  const all = await db.planDayEvent.findMany({
    where: { change: last.row.change },
    select: { dayId: true, changes: true, day: { select: { planId: true, date: true } } },
  });
  if (all.some((event) => event.day.planId !== planId)) return null;
  const alsoDays = all
    .filter((event) => event.dayId !== dayId)
    .map((event) => isoDate(event.day.date))
    .sort();
  if (SWAPS.has(cause.data)) {
    const swap = plan.lastSwap as { revision?: unknown } | null;
    if (swap?.revision !== plan.revision) return null;
    return { kind: 'swap', eventId: last.row.id, restore: [], alsoDays };
  }
  const meals = all.flatMap((event) => (event.changes as unknown as StoredEventChanges).meals);
  if (meals.length === 0 || !meals.every(portionOnly)) return null;
  return {
    kind: 'restore',
    eventId: last.row.id,
    restore: meals.map((meal) => ({ mealId: meal.mealId, scale: meal.before!.scale })),
    alsoDays,
  };
}
