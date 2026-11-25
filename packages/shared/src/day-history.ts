// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';

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
  'day-variant',
  'leftover',
  'leftover-undo',
  'favorite-set',
  'reroll',
  'retarget',
  'bought-by-weight',
  'kept',
]);
export type DayEventCause = z.infer<typeof DayEventCause>;

/**
 * The user's own choice of a day's portions, which the changes they do not make of the day leave as they are: `undo`
 * (an undo of a sizing put them back), `spread` (a spread over the rest of the plan gave them) or `kept` ("Zostaw
 * porcje jak są"). Their own change of the day ends it.
 */
export const KeptChoice = z.enum(['undo', 'spread', 'kept']);
export type KeptChoice = z.infer<typeof KeptChoice>;
