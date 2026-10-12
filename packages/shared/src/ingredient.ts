// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { Allergen, DietType, NaturalUnit, ProductCategory, Unit } from './enums.js';

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
  /** Nutrition per 100 canonical units: per 100 g, 100 ml or 100 pieces. */
  caloriesPer100: z.number().min(0),
  proteinPer100: z.number().min(0),
  fatPer100: z.number().min(0),
  carbsPer100: z.number().min(0),
  /** g per piece — required when canonicalUnit is `piece` for unit conversion. */
  gramsPerPiece: z.number().positive().nullable().default(null),
  /** g per ml — enables volume↔mass conversion for liquids. */
  density: z.number().positive().nullable().default(null),
  /**
   * Set for an ingredient that is counted, not weighed: what one piece of it
   * is called. Its quantities are shown in pieces of `gramsPerPiece` grams.
   */
  displayUnit: NaturalUnit.nullable().default(null),
  allergens: z.array(Allergen).default([]),
  /** Diet types this ingredient is compatible with. */
  dietCompatibility: z.array(DietType).default([]),
  tags: z.array(z.string()).default([]),
  /**
   * What one buys of it at a time, in the canonical unit, for an ingredient
   * that comes in a pack one cannot buy part of; null for what is bought
   * loose. A shopping list says how many packs a row comes to.
   */
  packSize: z.number().min(0).nullable().default(null),
  /**
   * What is left of an opened pack does not keep for long. A plan counts what
   * it leaves of such packs as waste, and leans towards using an opened one.
   */
  perishable: z.boolean().default(false),
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

/** The most ingredients that can be asked for by id at once. */
export const MAX_INGREDIENT_IDS = 200;

/**
 * What the ingredient catalogue is asked for: the ingredients of a list of
 * ids (`ids`, separated by commas), or the ones whose name holds `search`.
 */
export const IngredientListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  ids: z
    .string()
    .max(MAX_INGREDIENT_IDS * 37)
    .transform((list) => list.split(',').filter(Boolean))
    .pipe(z.array(z.string().uuid()).max(MAX_INGREDIENT_IDS))
    .optional(),
});
export type IngredientListQuery = z.infer<typeof IngredientListQuery>;

