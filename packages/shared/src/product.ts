// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { PRODUCT_REASON_LONGEST, PRODUCT_SEARCH, PRODUCT_TEXT } from './constants.js';
import { foldedProductText, productCodeOf } from './product-code.js';

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

/** Where a product's figures come from: Open Food Facts, a person whose product the instance accepted, or the reader. */
export const ProductSource = z.enum(['open_food_facts', 'instance', 'own']);
export type ProductSource = z.infer<typeof ProductSource>;

/** A product the instance knows. */
export const Product = z.object({
  id: z.string().uuid(),
  /** Null only for a product of the reader's own written without one. */
  code: z.string().nullable(),
  source: ProductSource,
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
  /**
   * A product of the reader's own for a code the base holds: the reader's
   * figures in place of the base's, for the reader alone, never sent to the base.
   */
  correction: z.boolean(),
  /** When Open Food Facts last changed it, where it says. */
  changedAt: z.string().datetime().nullable(),
});
export type Product = z.infer<typeof Product>;

/**
 * A product of an account's own: `own` for itself alone, `sent` waiting for the
 * instance's reviewers, `rejected` turned down or withdrawn, with the reason.
 */
export const OwnProductState = z.enum(['own', 'sent', 'rejected']);
export type OwnProductState = z.infer<typeof OwnProductState>;

export const OwnProduct = Product.extend({
  state: OwnProductState,
  reason: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type OwnProduct = z.infer<typeof OwnProduct>;

export const OwnProducts = z.object({ items: z.array(OwnProduct) });
export type OwnProducts = z.infer<typeof OwnProducts>;

/** A figure of a label in grams in 100: nothing holds more of anything. Left out, it is not known. */
const GramsIn100 = z.number().min(0).max(100).nullable().default(null);

/** The three macronutrients in 100 g, with what the rounding of a label can add. */
const MOST_MACROS_IN_100 = 105;
/** What the rounding of a label can put between a part and the whole it is a part of. */
const PART_SLACK = 0.5;

/**
 * What a person writes of a product of their own. Its energy is needed, and
 * what it leaves out of the rest is estimated as for a meal of one's own. What
 * cannot be true is refused; figures that merely do not add up are written, and
 * marked as doubtful for whoever reviews them. What is left out is not known,
 * which a changed product says as well.
 */
export const OwnProductBody = z
  .object({
    /** An EAN or UPC code as it was read or typed; null for a product without one. */
    code: z
      .string()
      .trim()
      .max(20)
      .refine((typed) => productCodeOf(typed) !== null, 'Not an EAN or UPC code.')
      .nullable()
      .default(null),
    name: z
      .string()
      .trim()
      .min(1)
      .max(PRODUCT_TEXT.name)
      .refine((typed) => foldedProductText(typed) !== '', 'A name holds a letter or a digit.'),
    brand: z.string().trim().max(PRODUCT_TEXT.brand).nullable().default(null),
    pack: z.string().trim().max(PRODUCT_TEXT.pack).nullable().default(null),
    unit: ProductUnit,
    packAmount: z.number().positive().max(100_000).nullable().default(null),
    servingAmount: z.number().positive().max(100_000).nullable().default(null),
    per100: z.object({
      calories: z.number().min(0).max(900),
      protein: GramsIn100,
      fat: GramsIn100,
      carbs: GramsIn100,
      fiber: GramsIn100,
      sugars: GramsIn100,
      salt: GramsIn100,
      saturatedFat: GramsIn100,
    }),
  })
  .superRefine(({ per100 }, context) => {
    const { protein, fat, carbs, sugars, saturatedFat } = per100;
    if ((protein ?? 0) + (fat ?? 0) + (carbs ?? 0) > MOST_MACROS_IN_100)
      context.addIssue({
        code: 'custom',
        path: ['per100', 'carbs'],
        message: `Protein, fat and carbohydrates come to at most ${MOST_MACROS_IN_100} g in 100.`,
      });
    if (sugars !== null && carbs !== null && sugars > carbs + PART_SLACK)
      context.addIssue({
        code: 'custom',
        path: ['per100', 'sugars'],
        message: 'Sugars are a part of the carbohydrates.',
      });
    if (saturatedFat !== null && fat !== null && saturatedFat > fat + PART_SLACK)
      context.addIssue({
        code: 'custom',
        path: ['per100', 'saturatedFat'],
        message: 'Saturated fat is a part of the fat.',
      });
  });
export type OwnProductBody = z.infer<typeof OwnProductBody>;

/** A product waiting for a reviewer. The account that sent it is not named. */
export const ProductUnderReview = OwnProduct.omit({
  state: true,
  reason: true,
  source: true,
  correction: true,
});
export type ProductUnderReview = z.infer<typeof ProductUnderReview>;

/** The products waiting, the longest first. */
export const ProductQueue = z.object({
  items: z.array(ProductUnderReview),
  total: z.number().int().nonnegative(),
});
export type ProductQueue = z.infer<typeof ProductQueue>;

/** A product taken as a reviewer saw it: one changed since is refused. */
export const AcceptProductRequest = z.object({ updatedAt: z.string().datetime() });
export type AcceptProductRequest = z.infer<typeof AcceptProductRequest>;

const ReasonToTheAuthor = z.string().trim().min(1).max(PRODUCT_REASON_LONGEST);

/** A product turned down, with what its author is told. */
export const RejectProductRequest = AcceptProductRequest.extend({ reason: ReasonToTheAuthor });
export type RejectProductRequest = z.infer<typeof RejectProductRequest>;

/** An accepted product withdrawn from the base, with what its author is told. */
export const WithdrawProductRequest = z.object({ reason: ReasonToTheAuthor });
export type WithdrawProductRequest = z.infer<typeof WithdrawProductRequest>;

/** A product the instance accepted, for its administrator. */
export const AcceptedProduct = Product.omit({ source: true, correction: true }).extend({
  acceptedAt: z.string().datetime(),
  acceptedBy: z.string().nullable(),
  /** Its author still has an account: a withdrawal goes back to them. */
  hasAuthor: z.boolean(),
});
export type AcceptedProduct = z.infer<typeof AcceptedProduct>;

export const AcceptedProducts = z.object({
  items: z.array(AcceptedProduct),
  page: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type AcceptedProducts = z.infer<typeof AcceptedProducts>;

export const AcceptedProductsQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});
export type AcceptedProductsQuery = z.infer<typeof AcceptedProductsQuery>;

/**
 * What the people of an instance added to its base, without who added it: what
 * the base holds of them is shared under the licence of Open Food Facts' data.
 */
export const ProductAdditions = z.object({
  license: z.literal('ODbL-1.0'),
  products: z.array(
    Product.pick({
      code: true,
      name: true,
      brand: true,
      pack: true,
      unit: true,
      packAmount: true,
      servingAmount: true,
      per100: true,
    }).extend({ acceptedAt: z.string().datetime().nullable() }),
  ),
});
export type ProductAdditions = z.infer<typeof ProductAdditions>;

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
