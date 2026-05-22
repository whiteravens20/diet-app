import { z } from 'zod';
import { ProductCategory, Unit } from './enums.js';

/** Request to build a shopping list from a plan or a date range within it. */
export const GenerateShoppingListRequest = z.object({
  planId: z.string().uuid(),
  /** Optional inclusive sub-range; omitted = whole plan. */
  fromDate: z.string().date().optional(),
  toDate: z.string().date().optional(),
});
export type GenerateShoppingListRequest = z.infer<typeof GenerateShoppingListRequest>;

/** One aggregated line: a single ingredient summed across all recipes. */
export const ShoppingListItem = z.object({
  id: z.string().uuid(),
  ingredientId: z.string().uuid(),
  name: z.string(),
  category: ProductCategory,
  /** Total quantity needed, in the canonical unit, after merging duplicates. */
  totalQuantity: z.number().min(0),
  unit: Unit,
  /** Quantity the user already has — deducted from the buy amount. */
  alreadyHaveQuantity: z.number().min(0).default(0),
  /** totalQuantity - alreadyHaveQuantity, floored at 0. */
  toBuyQuantity: z.number().min(0),
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
  groups: z.array(ShoppingListGroup),
  totalEstimatedCalories: z.number().min(0),
  createdAt: z.string().datetime(),
});
export type ShoppingList = z.infer<typeof ShoppingList>;

/** Mark an item's "already have" amount or its checked state. */
export const UpdateShoppingItemRequest = z.object({
  alreadyHaveQuantity: z.number().min(0).optional(),
  checked: z.boolean().optional(),
});
export type UpdateShoppingItemRequest = z.infer<typeof UpdateShoppingItemRequest>;
