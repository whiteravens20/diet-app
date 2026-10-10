// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { DisplayAmount, MAX_QUANTITY, Unit } from './enums.js';
import { Ingredient } from './ingredient.js';

/**
 * A pantry row — what a profile actually has on hand. Quantity is in `unit`.
 * A profile can hold the same ingredient in more than one unit (six eggs as
 * pieces next to 200 g of egg white as grams); adding more in a unit that is
 * already there adds to that row. Whatever reads the pantry (shopping lists,
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
  /** Free-form, displayed on the inventory page only — never sent to AI prompts. */
  note: z.string().max(280).nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

/**
 * Upsert payload. Posting with an `ingredientId + unit` that already exists
 * for this profile aggregates (`quantity += body.quantity`). Posting a fresh
 * combination creates a new row. `bestBefore` and `note` overwrite when
 * supplied; omitted fields preserve the existing row's values on aggregate.
 *
 * Refused with 400 `UNIT_NOT_CONVERTIBLE` when the ingredient cannot be
 * converted from `unit` (pieces of something that has no weight per piece),
 * and with 400 `QUANTITY_TOO_LARGE` when the row would hold more than its
 * unit's ceiling (`MAX_QUANTITY`).
 */
export const UpsertInventoryItem = z.object({
  ingredientId: z.string().uuid(),
  quantity: z.number().positive().max(Math.max(...Object.values(MAX_QUANTITY))),
  unit: Unit,
  bestBefore: z.string().date().nullable().optional(),
  note: z.string().max(280).nullable().optional(),
});
export type UpsertInventoryItem = z.infer<typeof UpsertInventoryItem>;

/**
 * Patch — anything omitted preserves the current value. The quantity is in the
 * row's unit and may not exceed that unit's ceiling (`MAX_QUANTITY`).
 */
export const PatchInventoryItem = z.object({
  quantity: z.number().min(0).max(Math.max(...Object.values(MAX_QUANTITY))).optional(),
  bestBefore: z.string().date().nullable().optional(),
  note: z.string().max(280).nullable().optional(),
});
export type PatchInventoryItem = z.infer<typeof PatchInventoryItem>;
