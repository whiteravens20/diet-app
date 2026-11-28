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
 * The pantry is kept by hand. What changes it for the user is a shopping list
 * (see `ShoppingListItem`) and, on a day no list covers, a meal marked eaten or
 * an entry of the diary once the user confirms taking what it ate off the
 * pantry (`EatenPantry`).
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
   * Fresh stock said to be still good past its best-before day without a new one ("Nadal dobre"): it counts at home
   * until its day or amount changes. Fresh stock past its day (`bestBefore` before the client's day) counts at home
   * for no shopping list and no plan otherwise; a package of the freezer keeps its own rule.
   */
  keptPastDate: z.boolean().default(false),
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

/**
 * "Nadal dobre": fresh stock past its best-before day is still good, with a new day (the client's or later) or
 * without one (`InventoryItem.keptPastDate`).
 */
export const StillGoodRequest = z.object({
  bestBefore: CalendarDay.nullable().default(null),
});
export type StillGoodRequest = z.infer<typeof StillGoodRequest>;

/**
 * A food of what eating took, or would take, off the pantry, each amount as a row of the pantry shows it: what is
 * counted in its pieces, the rest to the gram or millilitre. What is shown as taken is what is taken.
 */
export const EatenFromPantry = z.object({
  ingredientId: z.string().uuid(),
  name: z.string(),
  /** What the meal or the entry ate of it, rounded as it is taken: where the pantry holds enough, the same as `taken`. */
  eaten: DisplayAmount,
  /** What the pantry holds of it fresh now. */
  held: DisplayAmount,
  /** What is taken off the pantry: of an offer the lesser of the two, of what was taken what it took. */
  taken: DisplayAmount,
  /**
   * Of `taken`, what comes off the other pantry of a joint plan's kitchen, which lends what this one lacks of a shared
   * meal, and whose it is (the profile's name); null where nothing does.
   */
  borrowed: z.object({ amount: DisplayAmount, from: z.string() }).nullable(),
});
export type EatenFromPantry = z.infer<typeof EatenFromPantry>;

/**
 * What eating a meal of a plan, or an entry of the diary of an ingredient or a recipe, does to the pantry on a day no
 * shopping list covers ("Zdejmij ze spiżarni to, co zjedzono"): nothing by itself. `offer` is what taking it would
 * take now, empty where nothing is to be taken (a list covers the day, it is not eaten, it was taken already, the
 * pantry holds none of it, or it is eaten from a pot cooked already or a leftover); `taken` is what was taken, which
 * giving it back returns, empty where nothing was. A meal that cooks a pot ahead takes the whole pot's food.
 */
export const EatenPantry = z.object({
  /** Whose pantry it is: the name of the profile of the meal or the entry. */
  profileName: z.string(),
  offer: z.array(EatenFromPantry),
  taken: z.array(EatenFromPantry),
});
export type EatenPantry = z.infer<typeof EatenPantry>;

/**
 * Both portions of a shared meal of a joint plan, this plan's first, worked out together: each from its own pantry
 * first, then what each lacks from what the other pantry still holds, so that no food is offered twice.
 */
export const EatenPantries = z.array(EatenPantry).min(1).max(2);
export type EatenPantries = z.infer<typeof EatenPantries>;
