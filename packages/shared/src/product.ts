// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { PRODUCT_SEARCH } from './constants.js';

/**
 * A product with a barcode, as Open Food Facts describes it. Its figures are
 * those of its label: a second source beside the curated catalogue, for the
 * diary alone. They never enter a recipe or a plan.
 */

/** What a product is measured in. */
export const ProductUnit = z.enum(['g', 'ml']);
export type ProductUnit = z.infer<typeof ProductUnit>;

/** What a label says beside energy and the macronutrients, in grams; null where it says nothing that can be right. */
export const LabelNutrients = z.object({
  fiber: z.number().nullable(),
  sugars: z.number().nullable(),
  salt: z.number().nullable(),
  saturatedFat: z.number().nullable(),
});
export type LabelNutrients = z.infer<typeof LabelNutrients>;

/** A product the instance knows. */
export const Product = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  brand: z.string().nullable(),
  /** The pack in the words of its label. */
  pack: z.string().nullable(),
  unit: ProductUnit,
  /** How much a pack holds and how much a serving is, in `unit`, where the label says. */
  packAmount: z.number().nullable(),
  servingAmount: z.number().nullable(),
  /** In 100 of `unit`: kcal and grams, null where the label says nothing that can be right. */
  per100: LabelNutrients.extend({
    calories: z.number().nullable(),
    protein: z.number().nullable(),
    fat: z.number().nullable(),
    carbs: z.number().nullable(),
  }),
  /** The label gives no energy: the figure is worked out from its macronutrients. */
  energyWorkedOut: z.boolean(),
  /** The label's figures do not add up, or one of them cannot be right. */
  doubtful: z.boolean(),
  /** When Open Food Facts last changed it, where it says. */
  changedAt: z.string().datetime().nullable(),
});
export type Product = z.infer<typeof Product>;

/** A search of the products the instance holds, by words of a name or a brand. */
export const ProductSearchQuery = z.object({
  search: z.string().trim().min(PRODUCT_SEARCH.leastSigns).max(PRODUCT_SEARCH.longest),
});
export type ProductSearchQuery = z.infer<typeof ProductSearchQuery>;

/** What a search found, the products people scan most first. */
export const ProductSearchResult = z.object({
  items: z.array(Product).max(PRODUCT_SEARCH.found),
});
export type ProductSearchResult = z.infer<typeof ProductSearchResult>;
