// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { AiGenerationMeta } from './ai.js';
import {
  CalendarDay,
  DisplayUnit,
  MAX_QUANTITY,
  MealType,
  ProductCategory,
  Unit,
} from './enums.js';

/** The most shopping lists one plan may have at a time. */
export const MAX_LISTS_PER_PLAN = 10;

/** Request to build a shopping list from a plan or a date range within it. */
export const GenerateShoppingListRequest = z
  .object({
    planId: z.string().uuid(),
    /** Optional inclusive sub-range; omitted = whole plan. */
    fromDate: CalendarDay.optional(),
    toDate: CalendarDay.optional(),
  })
  .refine((request) => !request.fromDate || !request.toDate || request.fromDate <= request.toDate, {
    message: 'fromDate must not be after toDate.',
    path: ['toDate'],
  });
export type GenerateShoppingListRequest = z.infer<typeof GenerateShoppingListRequest>;

/**
 * One aggregated line: a single ingredient summed across all recipes.
 *
 * **How a row and the pantry relate.** `purchasedQuantity` is everything the
 * user has for the row: what is already at home (`alreadyHaveQuantity`, which
 * it starts at) plus what was bought. Ticking
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
   * What is already at home for the row. The list takes it from the pantry
   * when it is made: the pantry's stock, less what the profile's other lists
   * had already claimed and not yet ticked off, rounded down to what one
   * counts. The user may say otherwise afterwards (`UpdateShoppingItemRequest`):
   * the pantry does not know everything that is in a kitchen.
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
  /**
   * What is left to buy, in the packs the ingredient is sold in: how many,
   * what one holds (`size`, in `sizeUnit`: pieces where a pack holds a whole
   * number of them, grams or millilitres otherwise), and what whoever buys
   * them has for the row beside what was at home (`quantity`, in the row's
   * `unit`): what the packs hold together, and never less than
   * `toBuyQuantity`, because a need that is a spoonful over whole packs
   * takes the whole packs and is taken to be met by them. Null for an
   * ingredient that is not sold in packs, and for a row with nothing left to
   * buy.
   */
  packs: z
    .object({
      count: z.number().int().min(1),
      size: z.number().positive(),
      sizeUnit: DisplayUnit,
      quantity: z.number().positive(),
    })
    .nullable(),
  checked: z.boolean().default(false),
});
export type ShoppingListItem = z.infer<typeof ShoppingListItem>;

/** Items grouped under one product category. */
export const ShoppingListGroup = z.object({
  category: ProductCategory,
  items: z.array(ShoppingListItem),
  /** What the entries of the group come to in kilocalories: an estimate, as each of theirs is. */
  estimatedCalories: z.number().min(0),
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
  /**
   * True when the plan's menu for these dates no longer needs what the list
   * says: a meal was swapped, re-rolled or resized after the list was made.
   * Generating a list for the same dates again replaces this one.
   */
  stale: z.boolean(),
  createdAt: z.string().datetime(),
});
export type ShoppingList = z.infer<typeof ShoppingList>;

/** The most a quantity of a row may be, whatever its unit: each unit has a ceiling of its own, which the API holds a row to. */
const MOST = Math.max(...Object.values(MAX_QUANTITY));

/**
 * Change a row: what the user has for it, whether it is done, how much of it
 * was at home already. Setting `purchasedQuantity` to null clears it; a value
 * that reaches `totalQuantity` ticks the row. `alreadyHaveQuantity` stands in
 * the place of what the list took from the pantry: more than the row needs
 * counts as the need, what was bought beyond what was at home stays what it
 * was, and the row is ticked or unticked by what that comes to. A quantity is
 * in the row's `unit` and may not exceed that unit's ceiling (`MAX_QUANTITY`).
 */
export const UpdateShoppingItemRequest = z.object({
  purchasedQuantity: z.number().min(0).max(MOST).nullable().optional(),
  checked: z.boolean().optional(),
  alreadyHaveQuantity: z.number().min(0).max(MOST).optional(),
});
export type UpdateShoppingItemRequest = z.infer<typeof UpdateShoppingItemRequest>;

/**
 * Something a shopping list could do without, as the engine works it out.
 *
 * `merge`: two rows that one ingredient could stand for. The catalogue's
 * substitution rules name `to` as a substitute for `from`, the plan would take
 * it in every meal of the list's days that uses `from` (two meals at most:
 * more is no small change to propose), and the list would then ask for fewer
 * packs. The substitution itself is made in the plan, meal
 * by meal (`SwapIngredientRequest`), after which the list says it is stale.
 *
 * `leftover`: a row whose packs leave more than a fifth of a pack that
 * does not keep once it is opened. What would use it up is the plan's to say
 * (`UseUpSuggestions`).
 */
export const ListProposal = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merge'),
    from: z.object({ ingredientId: z.string().uuid(), name: z.string() }),
    to: z.object({ ingredientId: z.string().uuid(), name: z.string() }),
    /** The meals of the list's days that use `from`, in the order of the days. */
    meals: z
      .array(
        z.object({
          plannedMealId: z.string().uuid(),
          date: z.string().date(),
          mealType: MealType,
          title: z.string(),
        }),
      )
      .min(1)
      .max(2),
    /** How many packs fewer the list would ask for. */
    packsSaved: z.number().int().min(1),
    /** A model's sentence on it. Null when no model was asked, or it said none. */
    reason: z.string().max(200).nullable(),
  }),
  z.object({
    kind: z.literal('leftover'),
    ingredientId: z.string().uuid(),
    name: z.string(),
    /** What `left` and `packSize` are counted in: grams or millilitres. */
    unit: Unit,
    /** What the row's packs leave of the last of them, to the gram or millilitre. */
    left: z.number().int().min(1),
    packSize: z.number().positive(),
    reason: z.string().max(200).nullable(),
  }),
]);
export type ListProposal = z.infer<typeof ListProposal>;

/**
 * What a shopping list could do without, as
 * `POST /shopping-lists/:id/proposals` answers it: the proposals that save the
 * most first, or in the order a model gave them where one was asked and
 * answered. Nothing is written.
 */
export const ListProposals = z.object({
  planId: z.string().uuid(),
  proposals: z.array(ListProposal).max(8),
  /** Who put them in order, or why the engine's order stands. Null when no model was asked. */
  aiMeta: AiGenerationMeta.nullable(),
});
export type ListProposals = z.infer<typeof ListProposals>;
