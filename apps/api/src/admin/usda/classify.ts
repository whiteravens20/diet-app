// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What an imported food is taken to contain, and which diets it is known to
 * suit, from nothing but its description and its category in the source.
 *
 * The two questions have opposite defaults, because being wrong costs
 * differently:
 *
 *  - an **allergen** is assumed when a stem of its name appears, plural and
 *    compound forms included ("almonds", "buttermilk"), and for whole
 *    categories that consist of it. A false alarm hides a food from somebody
 *    who could have eaten it; a miss puts it on the plate of somebody who
 *    cannot. Names that only look alike are listed with the allergen they
 *    look like ("butternut", "almond milk", "eggplant", "oyster mushroom").
 *  - a **diet** is claimed only where it is positively established: a food
 *    from a category of plants, with no word for anything from an animal in
 *    its name and no sign of having been prepared with other things. Whatever
 *    is left, processed food above all, claims nothing until a person says so
 *    in the curated data.
 */
import type { Allergen } from '@diet-app/shared';

interface Rule {
  /** A stem that gives the allergen away. */
  has: RegExp;
  /** Phrases that hold a stem without holding the allergen; read out of the name first. */
  not?: RegExp;
}

const RULES: Record<Allergen, Rule> = {
  gluten: {
    has: /wheat|barley|\brye\b|bulgur|spelt|farro|kamut|khorasan|einkorn|emmer|freekeh|semolina|durum|triticale|seitan|bread|^pasta\b|noodle|couscous|cracker|cookie|\bcakes?\b|muffin|pastry|biscuit|bagel|pretzel|croissant|pancake|waffle|pie crust|pizza|\bmalt|\boats?\b|oatmeal|^flour, (00|bread|cake|all-purpose)\b/,
    not: /\bbuckwheat\b|\brice cakes?\b/g,
  },
  dairy: {
    has: /milk|cheese|yogurt|yoghurt|butter|cream|whey|casein|kefir|ghee|custard|lactose/,
    not: /\b(peanut|almond|cashew|hazelnut|walnut|pecan|pistachio|nut|seed|sunflower|sesame|cocoa|shea|apple|pumpkin) butter\b|\bbutter(nut|head|cup|bur)\w*|\bbutter ?beans?\b|\b(coconut|almond|soy|soya|oat|rice|cashew|hemp|pea|hazelnut) ?milk\b|\bmilk(fish|weed)\b|\bcream of tartar\b|\bcream(y|ed| style)\b/g,
  },
  eggs: { has: /\beggs?\b|eggnog|mayonnaise|meringue/ },
  nuts: {
    has: /almond|cashew|hazelnut|filbert|pecan|pistachio|walnut|brazil ?nut|macadamia|pine ?nut|pinon|chestnut|praline|marzipan|nougat/,
    not: /\bwater ?chestnuts?\b/g,
  },
  peanuts: { has: /peanut/ },
  soy: { has: /\bsoy|tofu|edamame|tempeh|\bmiso\b|natto|tamari/ },
  fish: { has: /\bfish\b|salmon|\btuna\b|\bcod\b|haddock|trout|halibut|sardine|mackerel|herring|anchov|tilapia|catfish|pollock|caviar|\broe\b/ },
  shellfish: {
    has: /shrimp|prawn|\bcrab|lobster|\bclams?\b|mussel|oyster|scallop|squid|octopus|crayfish|crawfish|krill|mollusk|crustacean|abalone|cuttlefish/,
    not: /\b(king )?oyster mushrooms?\b|\bmushrooms?, (king )?oyster\b/g,
  },
  sesame: { has: /sesame|tahini|hummus/ },
};

/** The source's own categories of whole plant foods. */
const PLANT_CATEGORIES = new Set([
  'Vegetables and Vegetable Products',
  'Fruits and Fruit Juices',
  'Legumes and Legume Products',
  'Nut and Seed Products',
  'Cereal Grains and Pasta',
  'Spices and Herbs',
]);

/** The source's categories that consist of meat, fish or seafood. */
const ANIMAL_CATEGORIES = new Set([
  'Beef Products',
  'Pork Products',
  'Poultry Products',
  'Lamb, Veal, and Game Products',
  'Sausages and Luncheon Meats',
  'Finfish and Shellfish Products',
]);

/** Rows of mixed categories that are plants by name: plant oils, sugar and syrup, milk made from plants. */
const PLANT_BY_NAME: Record<string, RegExp> = {
  'Fats and Oils':
    /^oil, (olive|canola|rapeseed|sunflower|safflower|corn|soybean|peanut|sesame|coconut|avocado|flaxseed|linseed|grapeseed|walnut|almond|hazelnut|palm|rice bran|cottonseed|mustard|vegetable)\b/,
  Sweets: /^(sugars?|syrups?|molasses)\b/,
  Beverages: /^(almond|oat|soy|rice|coconut|cashew|hemp|pea) milk\b/,
};

/** Anything that comes from an animal and is not caught as an allergen. */
const FROM_AN_ANIMAL =
  /\b(beef|pork|chicken|turkey|duck|goose|lamb|veal|mutton|venison|bacon|ham|sausage|salami|meat|gelatin|lard|tallow|suet|broth|bouillon|stock|bone|liver)\b/;
/** Honey, but not the apple or the melon named after it. */
const HONEY = /\bhoney\b/;
/** Made with things the name does not list: nothing can be claimed for it. */
const PREPARED = /\b(breaded|battered|fried|refried)\b/;

export interface Classified {
  allergens: Allergen[];
  /** `vegetarian`, `vegan` and `mediterranean` where they are established; never more. */
  diets: ('vegetarian' | 'vegan' | 'mediterranean')[];
}

/**
 * `description` and `sourceCategory` are the food's `description` and
 * `foodCategory` as the source gives them.
 */
export function classify(description: string, sourceCategory: string): Classified {
  const name = description.toLowerCase().trim();
  const glutenFree = /gluten[- ]free/.test(name);
  const found = new Set<Allergen>();
  for (const allergen of Object.keys(RULES) as Allergen[]) {
    const { has, not } = RULES[allergen];
    if (has.test(not ? name.replace(not, ' ').trim() : name)) found.add(allergen);
  }
  // A name that says so wins over a stem ("Bread, gluten-free").
  if (glutenFree) found.delete('gluten');

  // Whole categories that consist of an allergen, whatever the row is called.
  if (sourceCategory === 'Dairy and Egg Products' && !found.has('eggs')) found.add('dairy');
  if (sourceCategory === 'Baked Products' && !glutenFree) found.add('gluten');
  if (sourceCategory === 'Nut and Seed Products' && name.startsWith('nuts, ')) found.add('nuts');
  if (sourceCategory === 'Finfish and Shellfish Products' && !found.has('shellfish')) found.add('fish');

  const animal = ANIMAL_CATEGORIES.has(sourceCategory) || FROM_AN_ANIMAL.test(name) || found.has('fish') || found.has('shellfish');
  const dairyOrEgg = found.has('dairy') || found.has('eggs');
  const vegetarianByItsName = /\b(vegetarian|vegan|meatless)\b/.test(name);
  const unknown = PREPARED.test(name) && !vegetarianByItsName;
  const plantRow = PLANT_CATEGORIES.has(sourceCategory) || (PLANT_BY_NAME[sourceCategory]?.test(name) ?? false);
  const plant = plantRow && !animal && !dairyOrEgg && !HONEY.test(name) && !unknown;

  const diets: Classified['diets'] = [];
  if (plant) diets.push('vegetarian', 'vegan');
  // Milk, eggs and honey on their own: nothing was killed for them.
  else if (sourceCategory === 'Dairy and Egg Products' && !animal) diets.push('vegetarian');
  else if (name === 'honey') diets.push('vegetarian');

  // Whole plant foods, fish and seafood, and olive oil.
  if ((plant && PLANT_CATEGORIES.has(sourceCategory)) || sourceCategory === 'Finfish and Shellfish Products' || name.startsWith('oil, olive')) {
    diets.push('mediterranean');
  }
  return { allergens: [...found].sort(), diets };
}
