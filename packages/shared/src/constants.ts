// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { LOCALES } from './options.js';

/**
 * The lists and limits of the contract that a page needs without its
 * schemas: what a profile, a recipe and a mark choose from, and how much a
 * request may hold. The schemas that check them are built on these values,
 * so one place says what they are.
 *
 * This file needs nothing else of the contract but the languages
 * (`options.ts`). A page that only has to know these values takes them from
 * `@diet-app/shared/constants`, and loads no schema and no validation library
 * with them. A bundler takes a file of the contract whole, with every file it
 * takes from: a list kept beside its schema brings that schema along.
 */

/** The diets a profile may follow (`DietType`). */
export const DIET_TYPES = [
  'balanced',
  'high_protein',
  'low_carb',
  'vegetarian',
  'vegan',
  'keto',
  'mediterranean',
  'custom',
] as const;

/** The diets a recipe has to qualify for (`RecipeDietTag`). */
export const RECIPE_DIET_TAGS = [
  'vegetarian',
  'vegan',
  'mediterranean',
  'low_carb',
  'keto',
] as const;

/** The meals of a day (`MealType`). */
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'second_breakfast'] as const;

/** The set of active meal slots for a given meal count. */
export const MEAL_SLOTS_BY_COUNT: Record<number, (typeof MEAL_TYPES)[number][]> = {
  2: ['breakfast', 'dinner'],
  3: ['breakfast', 'lunch', 'dinner'],
  4: ['breakfast', 'lunch', 'dinner', 'snack'],
  5: ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'],
};

/** The allergens a recipe is flagged with and a profile may rule out (`Allergen`). */
export const ALLERGENS = [
  'gluten',
  'dairy',
  'eggs',
  'nuts',
  'peanuts',
  'soy',
  'fish',
  'shellfish',
  'sesame',
] as const;

/** The cuisines a recipe may be tagged with, a profile may prefer and a draft may be asked for (`Cuisine`). */
export const CUISINES = [
  'polish',
  'italian',
  'asian',
  'mediterranean',
  'middle_eastern',
  'mexican',
  'american',
  'indian',
] as const;

/** How the recipe a model is asked for is cooked (`CookingMethod`). */
export const COOKING_METHODS = [
  'baked',
  'grilled',
  'pan_fried',
  'boiled',
  'steamed',
  'stewed',
  'raw',
  'no_cook',
] as const;

/** How a profile feels about a recipe it marked (`FavoriteSentiment`). */
export const FAVORITE_SENTIMENTS = ['favorite', 'often', 'avoid'] as const;

/** All non-canonical locales — handy for "translate all" loops. */
export const NON_CANONICAL_LOCALES = LOCALES.filter((locale) => locale !== 'en');

/**
 * What a recipe may hold, whoever wrote it. The text is plain text: no markup,
 * one line per field. A quantity has a ceiling for one serving, because beyond
 * it the line is a mistake, not an ingredient of a meal.
 */
export const RECIPE_LIMITS = {
  /** Characters. */
  title: 120,
  description: 600,
  step: 300,
  note: 120,
  slug: 80,
  /** How many of each a recipe may have. */
  steps: 25,
  ingredients: 30,
  servings: 12,
  /** Preparing and cooking, each, in minutes. */
  minutes: 480,
  /** Of one ingredient in one serving, in the line's own unit. */
  perServing: { g: 1500, ml: 1500, piece: 20 },
} as const;

/** What the name of an ingredient and its storage hint may hold, in characters. */
export const INGREDIENT_NAME_LIMITS = { name: 120, storageHint: 300 } as const;

/** The most ingredients a search of the library may name at once. */
export const MAX_SEARCHED_INGREDIENTS = 10;

/**
 * What a meal written by hand may hold, in a plan or in the diary: its name in
 * characters, its servings, and of one serving its energy in kcal and each
 * macronutrient in grams. More than this in one serving is a slip of the
 * keyboard, not a meal.
 */
export const OWN_MEAL_LIMITS = {
  name: 120,
  servings: { min: 0.25, max: 20 },
  perServing: { calories: 5000, protein: 500, fat: 500, carbs: 1000 },
} as const;

/** The most entries a day of a profile's diary holds. */
export const MAX_DIARY_ENTRIES_A_DAY = 40;

/**
 * The most of one ingredient a diary entry may hold, in the unit it is given
 * in: more than anybody eats of one food in a day, and a bound on a slip of
 * the keyboard.
 */
export const DIARY_QUANTITY_LIMITS = { g: 5000, ml: 5000, piece: 50 } as const;

/** The most recipes one import looks at: the first of its document. */
export const MOST_RECIPES_PER_IMPORT = 100;

/** How large the request of one import may be, in bytes: what the API takes in one request. The document in it is a text no longer. */
export const MOST_IMPORT_BYTES = 90_000;

/** The most one run that fills a language takes on. */
export const MOST_TRANSLATIONS_PER_RUN = 200;

/**
 * The recipes a meal needs before a week of it stays inside the default limit
 * on repeats: the same recipe at most three times in seven days. With fewer, a
 * plan is still made and repeats a dish more often than a profile asks.
 */
export const VARIETY_DEPTH = 3;
