import { z } from 'zod';
import { Allergen, DietType, ProductCategory, Unit } from './enums.js';

/**
 * A curated product / ingredient record. This is **static seed data** and the
 * single source of truth for nutrition — AI never writes these values.
 * Nutrition is always stored per 100 g or per 100 ml of the canonical unit.
 */
export const Ingredient = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: ProductCategory,
  canonicalUnit: Unit,
  /** Nutrition per 100 canonical units (per 100 g / 100 ml / per piece). */
  caloriesPer100: z.number().min(0),
  proteinPer100: z.number().min(0),
  fatPer100: z.number().min(0),
  carbsPer100: z.number().min(0),
  /** g per piece — required when canonicalUnit is `piece` for unit conversion. */
  gramsPerPiece: z.number().min(0).nullable().default(null),
  /** g per ml — enables volume↔mass conversion for liquids. */
  density: z.number().min(0).nullable().default(null),
  allergens: z.array(Allergen).default([]),
  /** Diet types this ingredient is compatible with. */
  dietCompatibility: z.array(DietType).default([]),
  tags: z.array(z.string()).default([]),
  /** Typical retail pack size in canonical units — used by the reuse optimiser. */
  packSize: z.number().min(0).nullable().default(null),
  brand: z.string().nullable().default(null),
  storageHint: z.string().nullable().default(null),
});
export type Ingredient = z.infer<typeof Ingredient>;

/** A substitution rule between two ingredients within a category. */
export const SubstitutionRule = z.object({
  id: z.string().uuid(),
  fromIngredientId: z.string().uuid(),
  toIngredientId: z.string().uuid(),
  /** Notes shown to the user explaining the swap. */
  note: z.string().nullable().default(null),
});
export type SubstitutionRule = z.infer<typeof SubstitutionRule>;
