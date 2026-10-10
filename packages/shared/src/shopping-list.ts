// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { DisplayUnit, MAX_QUANTITY, ProductCategory, Unit } from './enums.js';

/** Request to build a shopping list from a plan or a date range within it. */
export const GenerateShoppingListRequest = z.object({
  planId: z.string().uuid(),
  /** Optional inclusive sub-range; omitted = whole plan. */
  fromDate: z.string().date().optional(),
  toDate: z.string().date().optional(),
});
export type GenerateShoppingListRequest = z.infer<typeof GenerateShoppingListRequest>;

/**
 * One aggregated line: a single ingredient summed across all recipes.
 *
 * **How a row and the pantry relate.** `purchasedQuantity` is everything the
 * user has for the row: what the list took as already at home
 * (`alreadyHaveQuantity`, which it starts at) plus what was bought. Ticking
 * the row off moves two things, and unticking moves them back:
 *
 *  - what the list counted as already at home leaves the pantry, because the
 *    plan now uses it;
 *  - what was bought beyond `totalQuantity` enters the pantry.
 *
 * The server records what it actually moved, not what it meant to move: when
 * the pantry no longer holds what the list counted on, less is taken, and
 * unticking gives back exactly that.
 */
export const ShoppingListItem = z.object({
  id: z.string().uuid(),
  ingredientId: z.string().uuid(),
  name: z.string(),
  category: ProductCategory,
  /**
   * How much the plan needs, in `unit`, rounded up to what one buys: whole
   * pieces, or the next 5 g or 5 ml.
   */
  totalQuantity: z.number().min(0),
  /**
   * The unit every quantity of the row is in: pieces for an ingredient that
   * is counted in pieces, the ingredient's canonical unit otherwise.
   */
  unit: Unit,
  /** What to call `unit` when showing the row: `slice` for bread, `clove` for garlic. */
  displayUnit: DisplayUnit,
  /**
   * What the list took as already at home when it was made: the pantry's
   * stock, less what the profile's other lists had already claimed and not
   * yet ticked off, rounded down to what one counts. Never changes afterwards.
   */
  alreadyHaveQuantity: z.number().min(0).default(0),
  /** totalQuantity - alreadyHaveQuantity, floored at 0. */
  toBuyQuantity: z.number().min(0),
  /**
   * Everything the user has for this row, the part already at home included.
   * Null until first edit. The row ticks itself when this reaches
   * `totalQuantity`.
   */
  purchasedQuantity: z.number().min(0).nullable().default(null),
  /**
   * Earliest best-before across pantry rows that contributed to
   * `alreadyHaveQuantity`. Surfaced on the "from pantry" chip so the user sees
   * urgency while shopping. Null when no contribution or no recorded expiry.
   */
  pantryBestBefore: z.string().date().nullable().default(null),
  /** Estimated calories contributed by this line (informational). */
  estimatedCalories: z.number().min(0),
  checked: z.boolean().default(false),
});
export type ShoppingListItem = z.infer<typeof ShoppingListItem>;

/** Items grouped under one product category. */
export const ShoppingListGroup = z.object({
  category: ProductCategory,
  items: z.array(ShoppingListItem),
});
export type ShoppingListGroup = z.infer<typeof ShoppingListGroup>;

export const ShoppingList = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  fromDate: z.string().date(),
  toDate: z.string().date(),
  /** Groups in aisle order, the same on every read. */
  groups: z.array(ShoppingListGroup),
  totalEstimatedCalories: z.number().min(0),
  createdAt: z.string().datetime(),
});
export type ShoppingList = z.infer<typeof ShoppingList>;

/**
 * Mark an item's purchased quantity or checked state. `alreadyHaveQuantity` is
 * a generate-time snapshot and is not user-editable. Setting `purchasedQuantity`
 * to null clears it; values >= totalQuantity auto-check the row server-side.
 * The quantity is in the row's `unit` and may not exceed that unit's ceiling
 * (`MAX_QUANTITY`).
 */
export const UpdateShoppingItemRequest = z.object({
  purchasedQuantity: z.number().min(0).max(Math.max(...Object.values(MAX_QUANTITY))).nullable().optional(),
  checked: z.boolean().optional(),
});
export type UpdateShoppingItemRequest = z.infer<typeof UpdateShoppingItemRequest>;
