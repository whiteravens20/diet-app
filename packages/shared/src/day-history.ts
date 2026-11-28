// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { MAX_DAY_EVENTS, MAX_MEALS_ON_A_PLAN_DAY } from './constants.js';
import { CalendarDay, MealType } from './enums.js';
import { MAX_PLAN_DAYS, MAX_PLAN_MEALS, PlanChangeEffects } from './meal-plan.js';

/**
 * What made a change of a plan's day: `swap` of a meal, `swap-undo` of a swap taken back, `ingredient-swap`,
 * `own-meal` added, `meal-removed`, `eaten` and `not-eaten` (the mark and taking it off), `diary` (an entry of the
 * day's diary written, changed or removed), `eaten-elsewhere` (a meal marked eaten in another plan that holds the
 * day), `resize` ("Dopasuj porcje dnia"), `undo` ("Cofnij ostatnie przeliczenie"), `spread` ("Rozłóż na resztę
 * planu" and the day settings' spreading), `day-settings`, `day-variant`, `leftover` and `leftover-undo`,
 * `favorite-set`, `reroll` (recipes drawn again), `retarget` (another target for the plan), `bought-by-weight` (a row
 * of a shopping list bought by weight) and `kept` ("Zostaw porcje jak są").
 */
export const DayEventCause = z.enum([
  'swap',
  'swap-undo',
  'ingredient-swap',
  'own-meal',
  'meal-removed',
  'eaten',
  'not-eaten',
  'diary',
  'eaten-elsewhere',
  'resize',
  'undo',
  'spread',
  'day-settings',
  // A week evened out from its line ("Wyrównaj tydzień"), with no setting of a day changed.
  'week-evened',
  'day-variant',
  'leftover',
  'leftover-undo',
  'favorite-set',
  'reroll',
  'retarget',
  // The days from today took the profile's number of meals a day ("Uzupełnij lub odejmij").
  'meal-count',
  'bought-by-weight',
  'kept',
  // The toppings of a plan made together came off: the other plan was removed (`joint-removed`), or the profile's
  // allergens, foods or diet no longer let them be given (`preferences`).
  'joint-removed',
  'preferences',
]);
export type DayEventCause = z.infer<typeof DayEventCause>;

/**
 * The user's own choice of a day's portions, which the changes they do not make of the day leave as they are: `undo`
 * (an undo of a sizing put them back), `spread` (a spread over the rest of the plan gave them) or `kept` ("Zostaw
 * porcje jak są"). Their own change of the day ends it.
 */
export const KeptChoice = z.enum(['undo', 'spread', 'kept']);
export type KeptChoice = z.infer<typeof KeptChoice>;

/** A meal as a change of its day found it, or left it. */
export const DayEventMealState = z.object({
  /** Its dish, in the reader's language, or the name of a meal of one's own; null for a recipe gone from the catalogue. */
  name: z.string().nullable(),
  /** Its servings as eaten: the plan's portion times the factor its sizing gave. */
  servings: z.number().min(0),
  calories: z.number().int().min(0),
  eaten: z.boolean(),
  /** What was left of a meal of the day before, eaten in the place of a dish. */
  leftover: z.boolean(),
});
export type DayEventMealState = z.infer<typeof DayEventMealState>;

/** A meal a change of its day moved: null `before` where the change put it in the day, null `after` where it took it off. */
export const DayEventMeal = z.object({
  mealId: z.string().uuid(),
  mealType: MealType,
  before: DayEventMealState.nullable(),
  after: DayEventMealState.nullable(),
});
export type DayEventMeal = z.infer<typeof DayEventMeal>;

/** A change of a plan's day, as its history tells it. */
export const DayEvent = z.object({
  id: z.string().uuid(),
  at: z.string().datetime(),
  cause: DayEventCause,
  /** The user changed this day; false where a change of other days moved it, through a rest of a pack the days share. */
  own: z.boolean(),
  /** Of a change of other days (`own` false): the days it was of. Empty otherwise. */
  from: z.array(CalendarDay).max(MAX_PLAN_DAYS),
  /** Its meals that the change moved, in the order of the day. */
  meals: z.array(DayEventMeal).max(MAX_MEALS_ON_A_PLAN_DAY * 2),
  /** The day's calorie target before and after, where the change moved it; null otherwise. */
  target: z.object({ before: z.number().int(), after: z.number().int() }).nullable(),
  /** The user's choice of the day's portions before and after, where the change made or ended one; null otherwise. */
  choice: z.object({ before: KeptChoice.nullable(), after: KeptChoice.nullable() }).nullable(),
  /** What the change did to the lists and the freezer, of every day it changed. */
  effects: PlanChangeEffects,
});
export type DayEvent = z.infer<typeof DayEvent>;

/**
 * What takes back the day's last change, where nothing changed the plan after it: `restore` puts its portions back
 * (`RebalanceRequest.restore`, with `scope` `day`), `swap` takes its swap back (`UndoSwapRequest`, with the plan's
 * `revision`). Offered for a change of portions or a swap, and not for one that was an undo itself.
 */
export const DayEventUndo = z.object({
  kind: z.enum(['restore', 'swap']),
  eventId: z.string().uuid(),
  /** For `restore`: what the request sends. Empty for `swap`. */
  restore: z
    .array(z.object({ mealId: z.string().uuid(), scale: z.number().min(0).max(10) }))
    .max(MAX_PLAN_MEALS),
  /** The other days of the plan the undo changes as well: those the change moved with this one. */
  alsoDays: z.array(CalendarDay).max(MAX_PLAN_DAYS),
});
export type DayEventUndo = z.infer<typeof DayEventUndo>;

/**
 * A day of a plan and its changes ("Historia dnia"), as `GET /meal-plans/:id/days/:dayId/history` answers: what holds
 * the day as it is (the user's choice of its portions, and what no sizing moves), and the changes, the latest first,
 * at most `MAX_DAY_EVENTS`, kept as long as the plan; with the undo of the last one where it is offered.
 */
export const DayHistory = z.object({
  planId: z.string().uuid(),
  dayId: z.string().uuid(),
  date: CalendarDay,
  /** The plan's revision as it was read: "Zostaw porcje jak są" sends it (`KeepDayRequest`). */
  revision: z.number().int().min(0),
  /** The user's choice of the day's portions, and when it was made; null where every change sizes the day. */
  kept: z.object({ choice: KeptChoice, at: z.string().datetime() }).nullable(),
  /** What no sizing of the day moves: its meals of one's own, the meals marked eaten, leftovers, the rests of packs it finishes and the entries of its diary. */
  holds: z.object({
    ownMeals: z.array(z.string()).max(MAX_MEALS_ON_A_PLAN_DAY),
    eatenMeals: z.array(z.string()).max(MAX_MEALS_ON_A_PLAN_DAY),
    leftovers: z.array(z.string()).max(MAX_MEALS_ON_A_PLAN_DAY),
    /** The foods whose rests of packs its meals finish. */
    rests: z.array(z.string()).max(MAX_MEALS_ON_A_PLAN_DAY),
    diaryEntries: z.number().int().min(0),
  }),
  events: z.array(DayEvent).max(MAX_DAY_EVENTS),
  undo: DayEventUndo.nullable(),
});
export type DayHistory = z.infer<typeof DayHistory>;

/**
 * "Zostaw porcje jak są": the day's portions as they are become the user's choice (`KeptChoice` `kept`), which only
 * their own change of the day ends. Made from the plan at `revision`; another change since answers 409 `PLAN_CHANGED`.
 */
export const KeepDayRequest = z.object({ revision: z.number().int().min(0).max(2_147_483_647) });
export type KeepDayRequest = z.infer<typeof KeepDayRequest>;
