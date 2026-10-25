// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { ALLERGENS, CUISINES, DIET_TYPES, MEAL_TYPES, RECIPE_DIET_TAGS } from './constants.js';
import { UNITS } from './units.js';

/** Biological sex — used only for the BMR formula; optional on profiles. */
export const Sex = z.enum(['male', 'female']);
export type Sex = z.infer<typeof Sex>;

/** Physical Activity Level — maps to a maintenance-calorie multiplier. */
export const ActivityLevel = z.enum([
  'sedentary', // 1.2  — little/no exercise
  'light', // 1.375 — 1-3 days/week
  'moderate', // 1.55  — 3-5 days/week
  'active', // 1.725 — 6-7 days/week
  'very_active', // 1.9   — hard daily training / physical job
]);
export type ActivityLevel = z.infer<typeof ActivityLevel>;

/** Supported diet types. `custom` defers entirely to explicit preferences. */
export const DietType = z.enum(DIET_TYPES);
export type DietType = z.infer<typeof DietType>;

/**
 * The diets a recipe has to qualify for. A recipe's `dietTags` hold the ones it
 * does, and they are worked out from its ingredients, never written by hand.
 * The remaining diets (balanced, high-protein, custom) take any recipe: they
 * are a matter of how a day is put together, not of what a single recipe is.
 */
export const RecipeDietTag = z.enum(RECIPE_DIET_TAGS);
export type RecipeDietTag = z.infer<typeof RecipeDietTag>;

/** True when a recipe with these tags may be planned for someone on `diet`. */
export function fitsDiet(dietTags: readonly string[], diet: DietType): boolean {
  return !RecipeDietTag.safeParse(diet).success || dietTags.includes(diet);
}

/** Weekly fat-loss target in kg. Drives the daily calorie deficit. */
export const WeeklyLossTarget = z.enum(['0.25', '0.5', '0.75', '1.0']);
export type WeeklyLossTarget = z.infer<typeof WeeklyLossTarget>;

/** Meal slot within a day. The active set depends on the profile meal count (2-5). */
export const MealType = z.enum(MEAL_TYPES);
export type MealType = z.infer<typeof MealType>;

/** The first and the last day a request may name. */
export const FIRST_DAY = '2000-01-01';
export const LAST_DAY = '2100-12-31';

/**
 * A calendar day a client names, as `2026-03-01`: a day there is, in the
 * years the application is for. Dates in this form compare as text.
 */
export const CalendarDay = z
  .string()
  .date()
  .refine((day) => day >= FIRST_DAY && day <= LAST_DAY, {
    message: `Must be a day from ${FIRST_DAY} to ${LAST_DAY}.`,
  });
export type CalendarDay = z.infer<typeof CalendarDay>;

/** The day `days` days after `day`, in the same form. */
export function dayAfter(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** How hard a recipe is to make. */
export const Difficulty = z.enum(['easy', 'medium', 'hard']);
export type Difficulty = z.infer<typeof Difficulty>;

/** Canonical product categories — also the shopping-list grouping keys. */
export const ProductCategory = z.enum([
  'vegetables',
  'fruits',
  'dairy',
  'meat',
  'fish',
  'grains',
  'legumes',
  'nuts_seeds',
  'fats_oils',
  'spices',
  'pantry',
  'beverages',
  'other',
]);
export type ProductCategory = z.infer<typeof ProductCategory>;

/** Canonical measurement units. The engine normalises everything to these. */
export const Unit = z.enum(UNITS);
export type Unit = z.infer<typeof Unit>;

/**
 * What one piece of an ingredient is called, for the ingredients people count
 * instead of weigh: an egg (`piece`), a `slice` of bread, a `clove` of garlic,
 * a `handful` of spinach. Its weight is the ingredient's `gramsPerPiece`.
 */
export const NaturalUnit = z.enum(['piece', 'slice', 'clove', 'handful']);
export type NaturalUnit = z.infer<typeof NaturalUnit>;

/** Every unit a quantity can be shown in. */
export const DisplayUnit = z.enum(['g', 'ml', ...NaturalUnit.options]);
export type DisplayUnit = z.infer<typeof DisplayUnit>;

/**
 * A quantity as a person reads it: rounded by the API (grams and millilitres
 * to the nearest 5 above 10, pieces to halves) and in the unit the ingredient
 * is handled in. The exact quantity next to it is what the engine works with.
 */
export const DisplayAmount = z.object({
  quantity: z.number().min(0),
  unit: DisplayUnit,
});
export type DisplayAmount = z.infer<typeof DisplayAmount>;

/**
 * The most of one ingredient a pantry row or a shopping row may hold: 100 kg,
 * 100 l or 1000 pieces. Far beyond any kitchen, and a bound on what a typing
 * slip can do to every later shopping list.
 */
export const MAX_QUANTITY: Record<Unit, number> = { g: 100_000, ml: 100_000, piece: 1_000 };

/** Recognised allergen flags. */
export const Allergen = z.enum(ALLERGENS);
export type Allergen = z.infer<typeof Allergen>;

/** The data sets of USDA FoodData Central the importer can read. */
export const FdcDataType = z.enum(['Foundation', 'SR Legacy']);
export type FdcDataType = z.infer<typeof FdcDataType>;

/**
 * One or more of them, each named once, given as a comma-separated list or as
 * a list. Parsed to the comma-separated form the source's own API takes.
 */
export const FdcDataTypes = z
  .union([z.string().max(100), z.array(z.string().max(40)).max(8)])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  )
  .pipe(
    z
      .array(FdcDataType)
      .min(1)
      .refine((list) => new Set(list).size === list.length, {
        message: 'A data set is named twice.',
      }),
  )
  .transform((list) => list.join(','));

/** What an import of the food database may be started with: the data sets to read, in the place of the configured ones. */
export const UsdaImportQuery = z.object({ dataTypes: FdcDataTypes.optional() });
export type UsdaImportQuery = z.infer<typeof UsdaImportQuery>;

/** Supported AI providers. */
export const AiProvider = z.enum(['openai', 'anthropic', 'openrouter', 'ollama']);
export type AiProvider = z.infer<typeof AiProvider>;

/**
 * The cuisines a recipe may be tagged with, a profile may prefer and a draft
 * may be asked for. A recipe has one or none: many a dish belongs to no
 * kitchen in particular. A preference leans the planner towards a recipe, and
 * a request leans a model towards a cuisine; neither rules anything out.
 */
export const Cuisine = z.enum(CUISINES);
export type Cuisine = z.infer<typeof Cuisine>;

/** Cooking-method hint for the AI recipe drafter. Soft preference. */
export const CookingMethod = z.enum([
  'baked',
  'grilled',
  'pan_fried',
  'boiled',
  'steamed',
  'stewed',
  'raw',
  'no_cook',
]);
export type CookingMethod = z.infer<typeof CookingMethod>;

/**
 * Recipe complexity band — shared by the curation queue's recipe generator
 * and the user-facing AI recipe drafter.
 */
export const Complexity = z.enum(['simple', 'medium', 'complex']);
export type Complexity = z.infer<typeof Complexity>;
