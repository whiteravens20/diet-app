import { z } from 'zod';
import { Unit } from './enums.js';
import { Ingredient } from './ingredient.js';

/**
 * A pantry row — what a profile actually has on hand. Quantity is in `unit`;
 * the engine's unit converter normalises against each recipe ingredient's
 * canonical unit at scoring/decrement time. A profile can hold the same
 * ingredient in multiple units (200 g chicken AND 1 piece chicken-breast
 * coexist); adding more at the same unit aggregates into the existing row.
 */
export const InventoryItem = z.object({
  id: z.string().uuid(),
  ingredient: Ingredient,
  quantity: z.number().min(0),
  unit: Unit,
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
 */
export const UpsertInventoryItem = z.object({
  ingredientId: z.string().uuid(),
  quantity: z.number().min(0),
  unit: Unit,
  bestBefore: z.string().date().nullable().optional(),
  note: z.string().max(280).nullable().optional(),
});
export type UpsertInventoryItem = z.infer<typeof UpsertInventoryItem>;

/** Patch — anything omitted preserves the current value. */
export const PatchInventoryItem = z.object({
  quantity: z.number().min(0).optional(),
  bestBefore: z.string().date().nullable().optional(),
  note: z.string().max(280).nullable().optional(),
});
export type PatchInventoryItem = z.infer<typeof PatchInventoryItem>;
