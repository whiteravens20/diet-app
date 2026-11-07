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

/** The first and the last day a request may name. */
export const FIRST_DAY = '2000-01-01';
export const LAST_DAY = '2100-12-31';

/** The most entries a day of a profile's diary holds. */
export const MAX_DIARY_ENTRIES_A_DAY = 40;

/**
 * How many days back a day of the diary still takes a new entry: a year, of a
 * leap year too. With the most a day holds, this bounds what a profile's diary
 * can pile up at once, however fast its requests come.
 */
export const DIARY_DAYS_BACK = 366;

/**
 * The most of one ingredient a diary entry may hold, in the unit it is given
 * in: more than anybody eats of one food in a day, and a bound on a slip of
 * the keyboard.
 */
export const DIARY_QUANTITY_LIMITS = { g: 5000, ml: 5000, piece: 50 } as const;

/**
 * What a search of the products the instance holds takes and answers with: a
 * word of at least `leastLetters`, of `leastSigns` where its script writes a
 * word in few signs, and at most `found` products.
 */
/** How long a name, a brand and a pack's words may be when a product is kept. */
export const PRODUCT_TEXT = { name: 160, brand: 80, pack: 40 } as const;

/**
 * What an account may do with products of its own: how many it holds, how many
 * times in 24 hours it writes or changes one, and how many it sends to the
 * instance's base in 24 hours.
 */
export const OWN_PRODUCTS = { held: 500, writtenADay: 50, sentADay: 10 } as const;

/** The most a reason given to the author of a product may say. */
export const PRODUCT_REASON_LONGEST = 500;

export const PRODUCT_SEARCH = {
  leastLetters: 3,
  leastSigns: 2,
  longest: 100,
  found: 20,
} as const;

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

/** What the buttons of the water card and of a reminder of water add, in millilitres: a small glass, a glass and a can. */
export const WATER_AMOUNTS_ML = [200, 250, 330] as const;

/** The water a day that a profile aims at unless it names its own, in millilitres. */
export const DEFAULT_WATER_TARGET_ML = 2000;

/** The bounds of a profile's own target of water a day, in millilitres. */
export const MIN_WATER_TARGET_ML = 250;
export const MAX_WATER_TARGET_ML = 10_000;

/** The most water one entry adds, in millilitres. */
export const MAX_WATER_ENTRY_ML = 5000;

/** The most entries a day of a profile holds. */
export const MAX_WATER_ENTRIES_A_DAY = 50;

/** The days of a week in sum: the full days before today, today left out. */
export const WEEK_DAYS = 7;

/**
 * How far a profile's target may move from the one a running plan was made
 * with, in kcal a day, before the plan says so and offers the new one: a few
 * kilograms of weight move it less, a change of activity more.
 */
export const TARGET_MOVED_LEAST_KCAL = 100;

/** How long "Nie teraz" puts off the offer to keep the weight once the target weight is reached, in days. */
export const TARGET_REACHED_LATER_DAYS = 14;

/** The hour, by the account's clock, from which a cooking ahead is reminded of the evening before. */
export const COOKING_REMINDER_HOUR = 18;

/**
 * When water is reminded of, by the account's clock: from the first hour to
 * before the last, while the day holds more than `WATER_REMINDER_BEHIND_ML`
 * less than an even pace to the target from `WATER_PACE_FROM_HOUR` to
 * `WATER_PACE_TO_HOUR`, at most every `WATER_REMINDER_EVERY_HOURS` hours.
 */
export const WATER_REMINDER_FROM_HOUR = 9;
export const WATER_REMINDER_TO_HOUR = 21;
export const WATER_PACE_FROM_HOUR = 8;
export const WATER_PACE_TO_HOUR = 20;
export const WATER_REMINDER_BEHIND_ML = 250;
export const WATER_REMINDER_EVERY_HOURS = 3;
