// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A dish's taste, form and starch base, as its ingredients and title suggest
 * them. What may be put on a dish's plate depends on the three (no second
 * starch beside its own, nothing sweet on a savoury dish, only what suits its
 * form), so every recipe is read with them: those somebody set, and where
 * nobody did, those proposed here.
 *
 *  - The starch base is the starchy ingredient (rice, pasta, potatoes,
 *    groats, bread) that brings the most of the dish's energy, from a tenth
 *    of it: a spoon of flour in a sauce makes no base.
 *  - The taste is sweet where something sweet is in it (fruit, honey, sugar,
 *    chocolate) and nothing savoury (meat, fish, an egg, a vegetable, a
 *    cheese of a savoury kind, salt, garlic, herbs); savoury otherwise.
 *  - The form follows the title in either language (a soup, a salad, a
 *    sandwich, a porridge or a dessert), a salad or a toast served beside the
 *    dish leaving it a plate; a sweet dish its title names no form of is a
 *    porridge or a dessert, any other a plate.
 *
 * Pure: the same lines and titles give the same traits.
 */
import { RecipeForm, RecipeTaste, StarchBase, type DishTraits, type Unit } from '@diet-app/shared';
import { toCanonical, UnitConversionError, type ConvertibleIngredient } from './units.js';

/** The part of an ingredient its traits depend on. */
export interface TraitsIngredient extends ConvertibleIngredient {
  /** The catalogue's identifier, the words its kind is told by; the name where it has none. */
  slug: string | null;
  name: string;
  category: string;
  caloriesPer100: number;
}

export interface TraitsLine {
  quantity: number;
  unit: Unit;
  ingredient: TraitsIngredient;
}

/** A starch is the dish's base from this share of its energy. */
const STARCH_BASE_FROM = 0.1;

const STARCHES: readonly (readonly [Exclude<StarchBase, 'none'>, RegExp])[] = [
  ['rice', /(^|-)rice($|-)|risotto|arborio|basmati|jasmine/],
  ['pasta', /pasta|spaghetti|penne|noodle|macaroni|fusilli|tagliatelle|lasagn|orzo|vermicelli/],
  ['potatoes', /potato|gnocchi/],
  [
    'groats',
    /oat|buckwheat|millet|barley|bulgur|couscous|quinoa|groats|semolina|polenta|cornmeal|amaranth/,
  ],
  [
    'bread',
    /bread(?!ed|crumb)|tortilla|wrap|(^|-)pitas?($|-)|bun($|-)|baguette|bagel|roll($|-)|flour|crackers?$|rusk/,
  ],
];

/** Named like a starch, and no starch of a dish: a vinegar, a drink, a sauce, a cookie, a flour of nuts or soy. */
const NOT_STARCH =
  /rice-vinegar|rice-wine|(oat|rice)-(milk|drink)|almond-flour|flour-almond|coconut-flour|flour-coconut|soy-flour|flour-soy|oat-bran|(^|-)sauce($|-)|cookie/;

const SWEET =
  /honey|sugar|maple|chocolate|cocoa|jam|date|raisin|vanilla|syrup|sweetener|stevia|cranberr/;
const SWEET_FRUIT =
  /banana|apple|berr|pear|mango|peach|plum|cherr|grape|kiwi|orange|mandarin|pineapple|melon|apricot|fig|strawberr|raspberr|blueberr|blackberr/;
const SAVOURY = new RegExp(
  [
    'garlic|onion|shallot|leek|salt|pepper(?!mint)|soy-sauce|cumin|paprika|curry|chili|chilli',
    'cheddar|feta|parmesan|gouda|mozzarella|halloumi|anchov|olive(?!-oil)|caper|mustard',
    'ketchup|vinegar|tahini|miso|ginger|turmeric|coriander|basil|oregano|thyme|rosemary|dill',
    'parsley|chive|bay-leaf|marjoram|caraway|stock|broth|bouillon|tomato|cucumber|spinach|kale',
    'broccoli|cabbage|zucchini|courgette|eggplant|lettuce|arugula|rocket|mushroom|bell-pepper',
    'radish|celery|asparagus|cauliflower|bean|lentil|chickpea|pea($|s$|-)|corn|edamame|tempeh|egg|avocado|bacon|ham',
  ].join('|'),
);
const SAVOURY_CATEGORIES: ReadonlySet<string> = new Set(['meat', 'fish']);

/**
 * The forms a title can name, in the order they are looked for. A salad or a
 * toast the title serves *with* the dish is a side: "patties with a tomato
 * salad" stay a plate. `\b` knows only ASCII letters here, so Polish words are
 * matched by their beginnings.
 */
const FORMS: readonly (readonly [Exclude<RecipeForm, 'plate'>, RegExp])[] = [
  [
    'soup',
    /\bsoup\b|\bbroth\b|chowder|bisque|borscht|\bzupa\b|zupka|krem z|barszcz|żurek|rosół|krupnik|kapuśniak|chłodnik|ramen|\bpho\b|minestrone|gazpacho/i,
  ],
  ['salad', /^(sałatka|surówka|łódeczki z sałaty)|^(?!.*\bwith\b.*\bsalad\b).*\bsalad\b/i],
  [
    'sandwich',
    /sandwich|\bon\b.*\btoast|^toast|^(?!.*\bwith\b.*\btoast).*\btoast\b|\bwrap\b|wraps|tortill|burrito|quesadilla|\bpita\b|bagel|kanap|^tost|^grzank|\bna\b.*grzan|bruschett|burger|panini|crostini|open-faced/i,
  ],
  [
    'porridge_dessert',
    /porridge|oatmeal|overnight oats|\boats\b|pudding|granola|muesli|smoothie|chia|parfait|dessert|owsiank|jaglank|budyń|deser|compote|kompot|yogurt bowl|jogurt z|crumble|baked apple/i,
  ],
];

/** A porridge by name, which stays one however savoury. */
const PORRIDGE = /porridge|oatmeal|oats|owsiank|jaglank/i;

const kindOf = (ingredient: Pick<TraitsIngredient, 'slug' | 'name'>): string =>
  ingredient.slug ?? ingredient.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function energyOf(line: TraitsLine): number {
  try {
    return (
      (toCanonical(line.quantity, line.unit, line.ingredient) * line.ingredient.caloriesPer100) /
      100
    );
  } catch (err) {
    if (err instanceof UnitConversionError) return 0;
    throw err;
  }
}

/** The starch an ingredient is, if it is one: what a dish's base would be named for it. */
export function starchKindOf(ingredient: Pick<TraitsIngredient, 'slug' | 'name'>): StarchBase {
  const kind = kindOf(ingredient);
  if (NOT_STARCH.test(kind)) return 'none';
  return STARCHES.find(([, pattern]) => pattern.test(kind))?.[0] ?? 'none';
}

/** The starch base a dish's lines suggest. */
function starchBaseOf(lines: readonly TraitsLine[]): StarchBase {
  const total = lines.reduce((sum, line) => sum + energyOf(line), 0);
  if (total <= 0) return 'none';
  const shares = new Map<StarchBase, number>();
  for (const line of lines) {
    const kind = kindOf(line.ingredient);
    if (NOT_STARCH.test(kind)) continue;
    const base = STARCHES.find(([, pattern]) => pattern.test(kind))?.[0];
    if (base) shares.set(base, (shares.get(base) ?? 0) + energyOf(line) / total);
  }
  let best: StarchBase = 'none';
  let most = 0;
  for (const [base, share] of shares) {
    if (share > most) [best, most] = [base, share];
  }
  return most >= STARCH_BASE_FROM ? best : 'none';
}

/** The taste a dish's lines suggest. */
function tasteOf(lines: readonly TraitsLine[]): DishTraits['taste'] {
  const sweet = lines.some(({ ingredient }) => {
    const kind = kindOf(ingredient);
    return SWEET.test(kind) || (ingredient.category === 'fruits' && SWEET_FRUIT.test(kind));
  });
  const savoury = lines.some(
    ({ ingredient }) =>
      SAVOURY.test(kindOf(ingredient)) || SAVOURY_CATEGORIES.has(ingredient.category),
  );
  return sweet && !savoury ? 'sweet' : 'savoury';
}

/** The form a dish's titles and taste suggest. */
function formOf(titles: readonly string[], taste: DishTraits['taste']): RecipeForm {
  const named = FORMS.find(([, pattern]) => titles.some((title) => pattern.test(title)))?.[0];
  if (
    named === 'porridge_dessert' &&
    taste === 'savoury' &&
    !titles.some((title) => PORRIDGE.test(title))
  ) {
    // Savoury pancakes and the like are eaten from a plate.
    return 'plate';
  }
  if (named) return named;
  return taste === 'sweet' ? 'porridge_dessert' : 'plate';
}

/** The traits a dish's titles (in every language it has) and ingredient lines suggest. */
export function proposeTraits(titles: readonly string[], lines: readonly TraitsLine[]): DishTraits {
  const taste = tasteOf(lines);
  return { taste, form: formOf(titles, taste), starchBase: starchBaseOf(lines) };
}

/** A recipe's traits as it is read: those set on it, each missing one (or one no longer known) as proposed. */
export function traitsOf(
  set: { taste: string | null; form: string | null; starchBase: string | null },
  propose: () => DishTraits,
): DishTraits {
  const taste = RecipeTaste.safeParse(set.taste);
  const form = RecipeForm.safeParse(set.form);
  const starchBase = StarchBase.safeParse(set.starchBase);
  if (taste.success && form.success && starchBase.success) {
    return { taste: taste.data, form: form.data, starchBase: starchBase.data };
  }
  const proposed = propose();
  return {
    taste: taste.success ? taste.data : proposed.taste,
    form: form.success ? form.data : proposed.form,
    starchBase: starchBase.success ? starchBase.data : proposed.starchBase,
  };
}
