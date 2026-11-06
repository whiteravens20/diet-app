// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type {
  Complexity,
  CookingMethod,
  Cuisine,
  DietType,
  Locale,
  MealType,
} from '@diet-app/shared';
import { COMPLEXITY_BANDS } from '../admin/drafts/recipe-generator.complexity.js';
import { KETO_BELOW_CARB_ENERGY, LOW_CARB_BELOW_CARB_ENERGY } from '../engine/recipe-facts.js';
import { MAIN_MEALS } from './model-recipe-rules.js';

/** An ingredient as the prompt of a draft lists it. */
export interface OfferedIngredient {
  id: string;
  slug: string;
  /** Its name in each language the recipe is written in, English always. */
  names: Partial<Record<Locale, string>> & { en: string };
  category: string;
  canonicalUnit: 'g' | 'ml' | 'piece';
  caloriesPer100: number;
  proteinPer100: number;
  gramsPerPiece: number | null;
}

export interface DraftPromptInput {
  mealType?: MealType;
  dietType: DietType;
  cuisine?: Cuisine;
  cookingMethod?: CookingMethod;
  complexity?: Complexity;
  kcalTarget?: number;
  prepTimeMaxMinutes?: number;
  catalogue: readonly OfferedIngredient[];
  favouriteIds: ReadonlySet<string>;
  /** English first, then the user's language when it is another. */
  targetLocales: readonly Locale[];
}

/** How many ingredients and steps a draft has when no complexity was asked for. */
const DEFAULT_SIZE = { minIngredients: 3, maxIngredients: 12, maxSteps: 12 } as const;

/** A figure as the catalogue's line gives it: tenths below a hundred, whole numbers above. */
const figure = (value: number): string =>
  value < 100 ? String(Math.round(value * 10) / 10) : String(Math.round(value));

const percent = (share: number): number => Math.round(share * 100);

const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });

/** "Polish": a language by its English name, which a model reads best. */
const languageName = (locale: Locale): string => LANGUAGES.of(locale) ?? locale;

/** "English (en), Polish (pl)": the languages of a draft. */
const languages = (locales: readonly Locale[]): string =>
  locales.map((locale) => `${languageName(locale)} (${locale})`).join(', ');

/** One line of the catalogue: the slug, the names, and what 100 g or ml of it holds. */
function catalogueLine(
  ingredient: OfferedIngredient,
  locales: readonly Locale[],
  favouriteIds: ReadonlySet<string>,
): string {
  const names = locales.map((locale) => ingredient.names[locale] ?? ingredient.names.en);
  const per = ingredient.canonicalUnit === 'ml' ? 'ml' : 'g';
  const piece = ingredient.gramsPerPiece ? `, a piece ${figure(ingredient.gramsPerPiece)} g` : '';
  const star = favouriteIds.has(ingredient.id) ? ' ⭐' : '';
  return (
    `- ${ingredient.slug}: ${names.join(' / ')} (${ingredient.category}; per 100 ${per}: ` +
    `${Math.round(ingredient.caloriesPer100)} kcal, ${figure(ingredient.proteinPer100)} g protein${piece})${star}`
  );
}

/**
 * The prompt of a recipe a user asks a model for. Every choice of the request
 * is a fixed value, never free text, so this is all the model reads beyond
 * the catalogue. What the request asks for is asked as a requirement: the
 * draft is held to the meal, the time and the calories afterwards, and to the
 * rules of `model-recipe-rules.ts` that the prompt states.
 */
export function buildDraftPrompt(input: DraftPromptInput): { system: string; user: string } {
  const locales = input.targetLocales;
  const several = locales.length > 1;
  const keyed = (type: string): string =>
    `{${locales.map((locale) => `"${locale}":${type}`).join(',')}}`;
  const shape =
    (several
      ? `{"titles":${keyed('string')},"descriptions":${keyed('string')},`
      : '{"title":string,"description":string,') +
    '"servings":1,"mealTypes":string[],"prepMinutes":int,"cookMinutes":int,' +
    '"difficulty":"easy"|"medium"|"hard",' +
    '"ingredients":[{"slug":string,"quantity":number,"unit":"g"|"ml"|"piece","note":string|null}],' +
    (several ? `"steps":${keyed('string[]')}}` : '"steps":string[]}');

  const system =
    'You write one cooking recipe for a meal-planning app. Every ingredient comes from the ' +
    'catalogue in the request, named by its slug: you never invent one and never rename one. ' +
    'You never write calories, protein, fat or carbohydrate: the app works them out from the ' +
    'catalogue. ' +
    (several
      ? `You write the title, the description and the steps in each of these languages: ${languages(locales)}. ` +
        'Each reads as a native speaker would write a recipe card, not word for word, with the ' +
        'same ingredients and the same steps. '
      : `You write the title, the description and the steps in ${languages(locales)}. `) +
    'Respond with one JSON object of exactly this shape, with no prose, no markdown fences and ' +
    `no other keys:\n${shape}`;

  const band = input.complexity
    ? COMPLEXITY_BANDS.find((one) => one.name === input.complexity)
    : undefined;
  const size = band ?? DEFAULT_SIZE;

  const asks: string[] = [];
  const carbs =
    input.dietType === 'keto'
      ? KETO_BELOW_CARB_ENERGY
      : input.dietType === 'low_carb'
        ? LOW_CARB_BELOW_CARB_ENERGY
        : null;
  asks.push(
    carbs === null
      ? `- Diet: ${input.dietType}. Every ingredient of the catalogue fits it.`
      : `- Diet: ${input.dietType}: under ${percent(carbs)} % of the dish's calories come from ` +
          'carbohydrate. Build it on protein, fat and low-carbohydrate vegetables.',
  );
  if (input.mealType) {
    const kind = MAIN_MEALS.has(input.mealType)
      ? 'a main dish'
      : 'a small dish, eaten between or before the main ones';
    asks.push(
      `- Meal: ${input.mealType}, ${kind}. "mealTypes" names every meal the dish suits, ` +
        `${input.mealType} among them.`,
    );
  }
  if (input.cuisine) {
    const kitchen = input.cuisine.replace(/_/g, ' ');
    asks.push(
      `- Cuisine: ${kitchen}. Write a dish a home cook of the ${kitchen} kitchen would ` +
        'recognise as theirs: one of its known dishes, or a home dish built on its typical ' +
        'ingredients, seasoning and way of cooking.',
    );
  }
  if (input.cookingMethod) {
    asks.push(
      `- Cooking method: ${input.cookingMethod.replace(/_/g, ' ')}: the main ingredient is ` +
        'prepared this way.',
    );
  }
  if (band) {
    asks.push(
      `- Complexity: ${band.name}: ${band.minIngredients} to ${band.maxIngredients} ` +
        `ingredients, at most ${band.maxSteps} steps, at most ${band.maxTotalMinutes} minutes in all.`,
    );
  }
  if (input.kcalTarget) {
    asks.push(
      `- Calories: about ${input.kcalTarget} kcal in the serving. Work the quantities out from ` +
        "the catalogue's figures so that the serving lands within a tenth of it.",
    );
  }
  if (input.prepTimeMaxMinutes) {
    asks.push(
      `- Time: preparing and cooking together take at most ${input.prepTimeMaxMinutes} minutes.`,
    );
  }
  if (input.favouriteIds.size > 0) {
    asks.push(
      "- Favourites: the ingredients marked ⭐ are the person's favourites; build on them where " +
        'they fit.',
    );
  }

  const rules = [
    `1. Use ${size.minIngredients} to ${size.maxIngredients} ingredients of the catalogue below, ` +
      'each named by its slug: the part of its line before the colon, copied exactly.',
    '2. The catalogue is all there is. A dish that needs something it lacks (a spice, a sauce, ' +
      'a dough, a stock) is not written: choose a dish that does without it. Never name an ' +
      'ingredient the catalogue lacks, in the list or in any text.',
    '3. A quantity is a number above 0, for the one serving. The unit is "g", or "ml" for an ' +
      'ingredient the catalogue gives per 100 ml; "piece" only for an ingredient whose line ' +
      'gives the weight of a piece.',
    `4. 2 to ${size.maxSteps} steps, each an imperative sentence with no number in front ` +
      '("Slice the chicken"). A step uses nothing the list does not hold, water alone excepted, ' +
      'and water is never on the list: a step that seasons with salt and pepper means salt and ' +
      'black pepper are on the list with their amounts. Every ingredient on the list is used ' +
      'in a step.',
    '5. A dish home cooks make: no contrived combinations. It is a meal of its own, never a side ' +
      'dish, and a main dish and a small one are never mixed in "mealTypes".',
    '6. The title names the dish as a cookbook would: what it is made of and how. It names no ' +
      'ingredient the list does not hold, not even to say it is left out, and never a diet, ' +
      'praise, a complexity or a kitchen (no "American ...", "Healthy ...", "Quick ..."), ' +
      "unless the place belongs to the dish's own name, as in Greek salad.",
    several
      ? '7. In each language, call an ingredient by the name its catalogue line gives in that ' +
        'language, in whatever form the sentence needs.'
      : '7. Call an ingredient by the name its catalogue line gives, in whatever form the ' +
        'sentence needs.',
    '8. "difficulty" follows the steps and the technique.',
  ];

  const user = [
    'The recipe:',
    ...asks,
    '',
    'Rules:',
    ...rules,
    '',
    `Ingredient catalogue (slug: ${locales.map((locale) => `${languageName(locale)} name`).join(' / ')}):`,
    ...input.catalogue.map((ingredient) => catalogueLine(ingredient, locales, input.favouriteIds)),
    '',
    'Respond with the JSON object only.',
  ].join('\n');

  return { system, user };
}
