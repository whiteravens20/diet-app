// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { MAX_PORTIONS } from './portions.js';
import { CalendarDay, DisplayAmount, MAX_QUANTITY, Unit } from './enums.js';
import { Ingredient } from './ingredient.js';

/** The most rows the pantry of a profile may hold. */
export const MAX_PANTRY_ROWS = 1000;

/**
 * A pantry row — what a profile actually has on hand. Quantity is in `unit`.
 * A profile can hold the same ingredient in more than one unit (three tomatoes
 * as pieces next to 200 g of them as grams); adding more in a unit that is
 * already there adds to that row. What is counted (eggs, slices, cloves) is
 * held in its pieces alone. Whatever reads the pantry (shopping lists,
 * plan generation) adds the rows of an ingredient up in its canonical unit,
 * so the unit must be one the ingredient can be converted from.
 *
 * The pantry is kept by hand. The one thing that changes it for the user is a
 * shopping list: see `ShoppingListItem`. Marking a meal eaten does not.
 */
export const InventoryItem = z.object({
  id: z.string().uuid(),
  ingredient: Ingredient,
  quantity: z.number().min(0),
  unit: Unit,
  /** The quantity as it is shown: rounded, and with a piece called what the ingredient calls it. */
  display: DisplayAmount,
  /** ISO date (yyyy-mm-dd). Null = no expiry tracked. */
  bestBefore: z.string().date().nullable().default(null),
  /**
   * In the freezer, apart from what is fresh: a package of its own, put in by hand or a rest of a plan given to the
   * pantry. Every freezing is one, and none adds to another; a food may have many, each with its day.
   */
  frozen: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

/**
 * Upsert payload. Posting fresh with an `ingredientId + unit` that already exists
 * for this profile aggregates (`quantity += body.quantity`); a fresh combination creates a new row. `bestBefore`
 * overwrites when supplied; when it is omitted, the existing row keeps its own on aggregate. Posting `frozen` puts
 * the amount into the freezer as packages of their own, `portions` of them split as evenly as the unit allows (what
 * is counted, in whole pieces), each with `bestBefore`; nothing frozen adds to another package. An amount of what is
 * counted, given in grams or millilitres, is turned into pieces and goes to its row in pieces.
 *
 * Refused with 400 `UNIT_NOT_CONVERTIBLE` when the ingredient cannot be
 * converted from `unit` (pieces of something that has no weight per piece;
 * the ingredient's `pantryUnits` say which units are taken), with 400
 * `QUANTITY_TOO_LARGE` when the row would hold more than its unit's ceiling
 * (`MAX_QUANTITY`), and with 400 `PORTIONS_TOO_MANY` where a portion would hold less than one of the unit.
 */
export const UpsertInventoryItem = z.object({
  ingredientId: z.string().uuid(),
  quantity: z
    .number()
    .positive()
    .max(Math.max(...Object.values(MAX_QUANTITY))),
  unit: Unit,
  bestBefore: CalendarDay.nullable().optional(),
  /** Into the freezer, as packages of their own beside what is fresh of the ingredient. */
  frozen: z.boolean().optional(),
  /** How many packages what goes into the freezer is split into; one where left out. What is fresh is one row. */
  portions: z.number().int().min(1).max(MAX_PORTIONS).optional(),
});
export type UpsertInventoryItem = z.infer<typeof UpsertInventoryItem>;

/**
 * "Zamroź": a fresh row of the pantry put into the freezer, split into `portions` packages of their own (one where
 * left out), as evenly as the unit allows: what is counted, in whole pieces.
 */
export const FreezeInventoryItem = z.object({
  portions: z.number().int().min(1).max(MAX_PORTIONS).optional(),
});
export type FreezeInventoryItem = z.infer<typeof FreezeInventoryItem>;

/**
 * The size to freeze a row of the pantry in, before "Zamroź" (`GET /inventory/:id/portion`): the most the profile's
 * plans that have a day after today eat of its food on a day and the next, from tomorrow on, a package coming out of
 * the freezer only whole (`PlanPacks.staysFrozen`), each with the other plan of its kitchen where it is a joint plan. In
 * the row's unit where it converts, whole pieces rounded down, the food's canonical unit otherwise (`unit`). Null where
 * none of them takes the food from packs.
 */
export const InventoryPortion = z.object({
  portion: z.number().int().min(1).nullable(),
  unit: Unit,
});
export type InventoryPortion = z.infer<typeof InventoryPortion>;

/** The upsert as it is sent: for which profile's pantry. */
export const UpsertInventoryItemRequest = UpsertInventoryItem.extend({
  profileId: z.string().uuid(),
});
export type UpsertInventoryItemRequest = z.infer<typeof UpsertInventoryItemRequest>;

/**
 * Patch — anything omitted preserves the current value. The quantity is in the
 * row's unit and may not exceed that unit's ceiling (`MAX_QUANTITY`).
 */
export const PatchInventoryItem = z.object({
  quantity: z
    .number()
    .min(0)
    .max(Math.max(...Object.values(MAX_QUANTITY)))
    .optional(),
  bestBefore: CalendarDay.nullable().optional(),
});
export type PatchInventoryItem = z.infer<typeof PatchInventoryItem>;
