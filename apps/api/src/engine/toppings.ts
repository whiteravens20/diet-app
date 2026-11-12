// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What may be put on one person's plate beside a dish the two people of a
 * joint plan eat, when that person's day would otherwise stay off its split or
 * its calorie target: a short list of foods of the catalogue, and the one
 * check each passes, whoever picks it, the engine or a model.
 *
 * A topping goes with the dish or not at all: never a second starch beside the
 * dish's own (no bread with rice), the dish's taste (nothing sweet on a savoury
 * plate, no yogurt in a soup), a form it suits, at a meal it goes with (no rice
 * at breakfast), and beside a dish built on tofu, tempeh or seitan only a food
 * of plants (no turkey with tofu); and it fits the person whose plate it is
 * on, who alone eats it: their diet, allergens, the ingredients they rule out
 * or dislike, and the kinds of protein their limits have no more meals of.
 *
 * Pure: the same day and options give the same choice.
 */
import {
  RECIPE_DIET_TAGS,
  type DishTraits,
  type Macros,
  type MealType,
  type RecipeForm,
  type StarchBase,
} from '@diet-app/shared';
import { distanceOnDiet, energyShares, MACROS_OFF } from './nutrition.js';
import type { Pack } from './packs.js';
import { REBALANCE_TOLERANCE } from './rebalance.js';

export interface Topping {
  /** What a meal keeps of the topping put on it. */
  key: string;
  /** The ingredient of the catalogue it is. */
  slug: string;
  /** The taste of the dishes it goes with: either, where it is `both`. */
  taste: 'savoury' | 'sweet' | 'both';
  /** The forms of the dishes it suits. */
  forms: readonly RecipeForm[];
  /** The starch it is, where it is one: then it goes only beside a dish with no starch base. */
  starch: Exclude<StarchBase, 'none'> | null;
  /** The meals it goes with: it is put only on a plate of one of them. */
  meals: readonly MealType[];
  /** The amounts it is put on a plate in, in its ingredient's canonical unit, smallest first. */
  amounts: readonly number[];
}

export const TOPPINGS: readonly Topping[] = [
  {
    key: 'egg',
    slug: 'large-egg',
    taste: 'savoury',
    forms: ['salad', 'plate', 'sandwich'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'lunch', 'dinner'],
    amounts: [55, 110],
  },
  {
    key: 'cottage_cheese',
    slug: 'cottage-cheese',
    taste: 'both',
    forms: ['sandwich', 'salad', 'porridge_dessert'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'snack', 'dinner'],
    amounts: [100, 150, 200],
  },
  {
    key: 'curd',
    slug: 'curd-cheese',
    taste: 'both',
    forms: ['sandwich', 'porridge_dessert'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'snack', 'dinner'],
    amounts: [50, 100, 150],
  },
  {
    key: 'greek_yogurt',
    slug: 'greek-yogurt',
    taste: 'sweet',
    forms: ['porridge_dessert'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'snack'],
    amounts: [100, 150, 200],
  },
  {
    key: 'tuna',
    slug: 'canned-tuna',
    taste: 'savoury',
    forms: ['salad', 'sandwich'],
    starch: null,
    meals: ['second_breakfast', 'lunch', 'dinner'],
    amounts: [70, 145],
  },
  {
    key: 'turkey',
    slug: 'turkey-breast',
    taste: 'savoury',
    forms: ['salad', 'plate', 'sandwich'],
    starch: null,
    meals: ['second_breakfast', 'lunch', 'dinner'],
    amounts: [50, 100, 150],
  },
  {
    key: 'tofu',
    slug: 'tofu',
    taste: 'savoury',
    forms: ['salad', 'plate', 'soup'],
    starch: null,
    meals: ['lunch', 'snack', 'dinner'],
    amounts: [50, 100, 150],
  },
  {
    key: 'chickpeas',
    slug: 'chickpeas',
    taste: 'savoury',
    forms: ['salad', 'plate', 'soup'],
    starch: null,
    meals: ['second_breakfast', 'lunch', 'dinner'],
    amounts: [50, 100, 150],
  },
  {
    key: 'pumpkin_seeds',
    slug: 'pumpkin-seeds',
    taste: 'both',
    forms: ['soup', 'salad', 'porridge_dessert'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'],
    amounts: [10, 20, 30],
  },
  {
    key: 'walnuts',
    slug: 'walnuts',
    taste: 'both',
    forms: ['salad', 'porridge_dessert'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'],
    amounts: [10, 20, 30],
  },
  {
    key: 'avocado',
    slug: 'avocado',
    taste: 'savoury',
    forms: ['salad', 'plate', 'sandwich'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'],
    amounts: [85, 170],
  },
  {
    key: 'olive_oil',
    slug: 'olive-oil',
    taste: 'savoury',
    forms: ['salad', 'plate'],
    starch: null,
    meals: ['second_breakfast', 'lunch', 'dinner'],
    amounts: [10, 20],
  },
  {
    key: 'peanut_butter',
    slug: 'peanut-butter',
    taste: 'sweet',
    forms: ['porridge_dessert', 'sandwich'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'snack'],
    amounts: [15, 30],
  },
  {
    key: 'rye_bread',
    slug: 'rye-bread',
    taste: 'savoury',
    forms: ['soup', 'salad', 'plate'],
    starch: 'bread',
    meals: ['breakfast', 'second_breakfast', 'lunch', 'dinner'],
    amounts: [32, 64, 96],
  },
  {
    key: 'buckwheat',
    slug: 'buckwheat-groats',
    taste: 'savoury',
    forms: ['plate'],
    starch: 'groats',
    meals: ['lunch', 'dinner'],
    amounts: [50, 75, 100],
  },
  {
    key: 'rice',
    slug: 'white-rice',
    taste: 'savoury',
    forms: ['plate'],
    starch: 'rice',
    meals: ['lunch', 'dinner'],
    amounts: [50, 75, 100],
  },
  {
    key: 'potatoes',
    slug: 'potato',
    taste: 'savoury',
    forms: ['plate'],
    starch: 'potatoes',
    meals: ['lunch', 'dinner'],
    amounts: [100, 200, 300],
  },
  {
    key: 'banana',
    slug: 'banana',
    taste: 'sweet',
    forms: ['porridge_dessert'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'snack'],
    amounts: [120],
  },
  {
    key: 'blueberries',
    slug: 'blueberries',
    taste: 'sweet',
    forms: ['porridge_dessert'],
    starch: null,
    meals: ['breakfast', 'second_breakfast', 'snack'],
    amounts: [50, 100],
  },
];

/** The toppings by what a meal keeps of them. */
export const TOPPING_BY_KEY: ReadonlyMap<string, Topping> = new Map(
  TOPPINGS.map((topping) => [topping.key, topping]),
);

/** The food a topping is, as the check reads it. */
export interface ToppingFood {
  id: string;
  allergens: readonly string[];
  dietCompatibility: readonly string[];
  proteinKind: string | null;
}

/** A dish as the check of a topping reads it: what it is, and whether it is built on a stand-in for meat. */
export interface ToppingDish extends DishTraits {
  /** It holds tofu, tempeh or seitan (`holdsAMeatStandIn`): the plate beside it stays of plants. */
  meatStandIn: boolean;
}

/** The ingredients that stand in for meat in a dish, by their slugs. */
const MEAT_STAND_IN = /(^|-)(tofu|tempeh|seitan)($|-)/;

/** Whether a dish of these ingredients (by their slugs) is built on a stand-in for meat. */
export const holdsAMeatStandIn = (slugs: readonly (string | null)[]): boolean =>
  slugs.some((slug) => slug !== null && MEAT_STAND_IN.test(slug));

/** The person whose plate a topping would be on, as the check reads them. */
export interface ToppingEater {
  diet: string;
  allergens: readonly string[];
  /** Ingredients they rule out. */
  excluded: ReadonlySet<string>;
  /** Ingredients they dislike. */
  disliked: ReadonlySet<string>;
  /** Kinds of protein their limits have no more meals of on that day, or in its seven days. */
  fullKinds: ReadonlySet<string>;
}

/** Why a topping may not be put beside a dish for a person; each rule is checked in this order. */
export type ToppingRefusal =
  | 'second_starch'
  | 'taste'
  | 'form'
  | 'meal'
  | 'plant_dish'
  | 'diet'
  | 'allergen'
  | 'excluded'
  | 'disliked'
  | 'protein_kind';

const DIETS_BY_INGREDIENT: ReadonlySet<string> = new Set(RECIPE_DIET_TAGS);

/** The one check: why `topping` may not go beside `dish` on `eater`'s plate, or null where it may. */
export function toppingRefusal(
  topping: Topping,
  food: ToppingFood,
  dish: ToppingDish,
  meal: MealType,
  eater: ToppingEater,
): ToppingRefusal | null {
  if (topping.starch !== null && dish.starchBase !== 'none') return 'second_starch';
  if (topping.taste !== 'both' && topping.taste !== dish.taste) return 'taste';
  if (!topping.forms.includes(dish.form)) return 'form';
  if (!topping.meals.includes(meal)) return 'meal';
  if (dish.meatStandIn && !food.dietCompatibility.includes('vegan')) return 'plant_dish';
  // A diet that holds recipes to their ingredients holds a topping to its own; the others take any.
  if (DIETS_BY_INGREDIENT.has(eater.diet) && !food.dietCompatibility.includes(eater.diet))
    return 'diet';
  if (food.allergens.some((allergen) => eater.allergens.includes(allergen))) return 'allergen';
  if (eater.excluded.has(food.id)) return 'excluded';
  if (eater.disliked.has(food.id)) return 'disliked';
  if (food.proteinKind !== null && eater.fullKinds.has(food.proteinKind)) return 'protein_kind';
  return null;
}

/** Energy and macronutrients. */
export interface Figures {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/** A meal of the eater a topping may be put on (shared, not eaten, without one), which meal it is, and its dish's traits. */
export interface ToppingPlace {
  mealId: string;
  meal: MealType;
  dish: ToppingDish;
  /** The one topping this place may be given, where a model named it; it still passes the check, or the place gets none. */
  only?: string;
}

/** A topping that may be given, with what 100 of its canonical unit holds. */
export interface ToppingOption {
  topping: Topping;
  food: ToppingFood;
  per100: Figures;
  /** The pack it comes in, where an opened one does not keep; left out where it keeps. */
  pack?: Pack;
}

export interface ToppingChoice {
  mealId: string;
  key: string;
  /** In the topping's canonical unit. */
  amount: number;
}

/** A topping that does not bring a day this much nearer its split is not worth a plate. */
export const LEAST_GAIN = 0.01;

const scaled = (per100: Figures, amount: number): Figures => ({
  calories: (per100.calories * amount) / 100,
  protein: (per100.protein * amount) / 100,
  fat: (per100.fat * amount) / 100,
  carbs: (per100.carbs * amount) / 100,
});

/**
 * The topping, its place and its amount for a day, the check letting each
 * through. Where the day is off its split, each is judged by the split, the
 * rest of the day taken as sized again around it to the calorie target; else,
 * where the day is under its target with its portions sized as far as they go,
 * by its calories, without leaving the split. Of those that bring the day back
 * (onto its split, or into the window of its target), the one the person had
 * least of late (`used`, by key) is taken, then the one that brings it nearest;
 * where none brings it back, the one that brings it nearest. Null where the day
 * stands on both already, or nothing brings it nearer by `LEAST_GAIN`.
 *
 * In a plan that wastes less, `leavesMore` says how much more the kitchen's
 * packs would leave with a topping (`PackKitchen`), and of those that bring the
 * day back, one that takes from what they would leave comes first, then one
 * that changes nothing of them, and one that leaves more only where no other
 * brings the day back.
 */
export function bestTopping(
  day: Figures,
  target: number,
  aim: Macros,
  places: readonly ToppingPlace[],
  options: readonly ToppingOption[],
  eater: ToppingEater,
  used: ReadonlyMap<string, number> = new Map(),
  leavesMore?: (option: ToppingOption, amount: number) => number,
): ToppingChoice | null {
  const aimed = energyShares(aim);
  if (aimed === null || target <= 0) return null;
  const distance = (held: Macros): number => {
    const shares = energyShares(held);
    return shares === null ? Number.POSITIVE_INFINITY : distanceOnDiet(shares, aimed, eater.diet);
  };
  const off = distance(day) > MACROS_OFF;
  const under = day.calories < target * (1 - REBALANCE_TOLERANCE);
  if (!off && !under) return null;

  let best: ToppingChoice | null = null;
  let bestScore = off ? distance(day) - LEAST_GAIN : (target - day.calories) / target - LEAST_GAIN;
  // Of those that bring the day back: the kindest to the packs, the least used of late, then the nearest.
  let back: { choice: ToppingChoice; packs: number; times: number; score: number } | null = null;
  /** 0 for a topping that takes from what the packs would leave, 1 for one that changes nothing of them, 2 for one that leaves more. */
  const packsOf = (option: ToppingOption, amount: number): number => {
    const more = leavesMore?.(option, amount) ?? 0;
    return more < -1e-6 ? 0 : more > 1e-6 ? 2 : 1;
  };
  const backAt = off ? MACROS_OFF : REBALANCE_TOLERANCE;
  for (const place of places) {
    for (const option of options) {
      if (place.only !== undefined && option.topping.key !== place.only) continue;
      if (toppingRefusal(option.topping, option.food, place.dish, place.meal, eater) !== null)
        continue;
      for (const amount of option.topping.amounts) {
        const added = scaled(option.per100, amount);
        let score: number;
        if (off) {
          // The rest of the day sized around the topping to the target.
          const rest = day.calories > 0 ? Math.max(0, (target - added.calories) / day.calories) : 0;
          score = distance({
            protein: day.protein * rest + added.protein,
            fat: day.fat * rest + added.fat,
            carbs: day.carbs * rest + added.carbs,
          });
        } else {
          const held = {
            protein: day.protein + added.protein,
            fat: day.fat + added.fat,
            carbs: day.carbs + added.carbs,
          };
          if (distance(held) > MACROS_OFF) continue;
          score = Math.abs(target - day.calories - added.calories) / target;
        }
        if (score < bestScore) {
          bestScore = score;
          best = { mealId: place.mealId, key: option.topping.key, amount };
        }
        if (score > backAt) continue;
        const times = used.get(option.topping.key) ?? 0;
        const packs = packsOf(option, amount);
        if (
          back === null ||
          packs < back.packs ||
          (packs === back.packs &&
            (times < back.times || (times === back.times && score < back.score)))
        ) {
          back = {
            choice: { mealId: place.mealId, key: option.topping.key, amount },
            packs,
            times,
            score,
          };
        }
      }
    }
  }
  return back?.choice ?? best;
}
