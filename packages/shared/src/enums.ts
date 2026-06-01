import { z } from 'zod';

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
export const DietType = z.enum([
  'balanced',
  'high_protein',
  'low_carb',
  'vegetarian',
  'vegan',
  'keto',
  'mediterranean',
  'custom',
]);
export type DietType = z.infer<typeof DietType>;

/** Weekly fat-loss target in kg. Drives the daily calorie deficit. */
export const WeeklyLossTarget = z.enum(['0.25', '0.5', '0.75', '1.0']);
export type WeeklyLossTarget = z.infer<typeof WeeklyLossTarget>;

/** Meal slot within a day. The active set depends on the profile meal count (2-5). */
export const MealType = z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'second_breakfast']);
export type MealType = z.infer<typeof MealType>;

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
export const Unit = z.enum(['g', 'ml', 'piece']);
export type Unit = z.infer<typeof Unit>;

/** Recognised allergen flags. */
export const Allergen = z.enum([
  'gluten',
  'dairy',
  'eggs',
  'nuts',
  'peanuts',
  'soy',
  'fish',
  'shellfish',
  'sesame',
]);
export type Allergen = z.infer<typeof Allergen>;

/** Supported AI providers. */
export const AiProvider = z.enum(['openai', 'anthropic', 'openrouter', 'ollama']);
export type AiProvider = z.infer<typeof AiProvider>;

/**
 * Cuisine hint for the AI recipe drafter (F20). Soft preference — when set
 * the prompt biases the model toward that cuisine, but the model can fall
 * back to any catalogue ingredient when the cuisine + diet + meal-type
 * intersection is too narrow.
 */
export const Cuisine = z.enum([
  'polish',
  'italian',
  'asian',
  'mediterranean',
  'middle_eastern',
  'mexican',
  'american',
  'indian',
]);
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
 * (Phase D8 of the curation plan) and the user-facing AI recipe drafter.
 */
export const Complexity = z.enum(['simple', 'medium', 'complex']);
export type Complexity = z.infer<typeof Complexity>;
