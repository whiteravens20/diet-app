// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A person's own plate of a dish two people of a joint plan share (cooking
 * together, stage C). A dish served on a plate has parts that lie apart, and
 * each person's portion may hold them in proportions of its own: more of the
 * protein for one, more of the starch for the other, each part of a plate from
 * half to one and a half of the recipe's proportion, the portion's energy kept.
 * The pot is the sum of the plates. The parts are read from the ingredients
 * alone (`partOf`): protein where the ingredient is a kind of protein other
 * than dairy, starch where it is a starch, vegetables, and the rest (fat,
 * sauce, spices, cheese), which goes with the plate's share as a whole.
 *
 * Pure: the same lines and days give the same plate.
 */
import type { Macros, ProteinKind } from '@diet-app/shared';
import { starchKindOf, type TraitsIngredient } from './dish-traits.js';
import { distanceOnDiet, energyShares } from './nutrition.js';
import type { RebalanceMeal } from './rebalance.js';

/** The part of a dish an ingredient line is. */
export type PlatePart = 'protein' | 'starch' | 'vegetables' | 'rest';

/** The parts whose share of a plate may move; the rest goes with the plate. */
const MOVING_PARTS = ['protein', 'starch', 'vegetables'] as const;

/** How much of each moving part a plate holds, against the recipe's proportion at the same portion. */
export type Plate = Record<(typeof MOVING_PARTS)[number], number>;

/** A plate in the recipe's own proportions. */
export const WHOLE_PLATE: Plate = { protein: 1, starch: 1, vegetables: 1 };

/** How far a part of a plate may move from the recipe's proportion. */
export const PLATE_RANGE = { least: 0.5, most: 1.5 } as const;

/** The steps a part of a plate moves by. */
const STEP = 0.05;

/** A plate is changed only where it brings the person's day this much nearer its split. */
const WORTH = 0.005;

/** Of two plates as good, the one nearer the recipe: a ten-thousandth of the distance for each step away from it. */
const NEAR_THE_RECIPE = 0.0001;

/** The part of an ingredient its part of a dish depends on: its kind (`slug`, or its name), category and kind of protein. */
export interface PartIngredient extends Pick<TraitsIngredient, 'slug' | 'name'> {
  category: string | null;
  proteinKind: ProteinKind | string | null;
}

/** The part of a dish served on a plate an ingredient is. */
export function partOf(ingredient: PartIngredient): PlatePart {
  if (starchKindOf(ingredient) !== 'none') return 'starch';
  if (ingredient.proteinKind && ingredient.proteinKind !== 'dairy') return 'protein';
  if (ingredient.category === 'vegetables') return 'vegetables';
  return 'rest';
}

/** What a part of a portion holds: its energy and the grams of each macronutrient. */
export type PartFigures = Macros & { calories: number };

export interface PlateInput {
  /** What each part of the person's portion holds as the recipe has it. */
  parts: Record<PlatePart, PartFigures>;
  /** What the rest of the person's day holds: every other meal of it. */
  day: Macros;
  /** The split the person's day aims at, and their diet, whose ceilings of carbohydrate the distance knows. */
  aim: Macros;
  dietType: string;
  /** The plate the portion has now, which it keeps unless another brings the day nearer by enough. */
  now?: Plate | null;
}

/** Less energy than this in a part is none: it does not move. */
const NO_ENERGY = 1;

/**
 * The plate of a person's portion that brings their day nearest its split:
 * each moving part from half to one and a half of the recipe's proportion, by
 * steps of a twentieth, the portion's energy kept (the part with the most of
 * it takes what the others leave), the rest at the recipe's. The plate it has now
 * (the recipe's own proportions where it has none) where no other is worth the
 * change, and the recipe's where fewer than two parts can move.
 */
export function plateOf(input: PlateInput): Plate {
  const moving = MOVING_PARTS.filter((part) => input.parts[part].calories >= NO_ENERGY);
  if (moving.length < 2) return WHOLE_PLATE;
  const energy = MOVING_PARTS.reduce((sum, part) => sum + input.parts[part].calories, 0);
  const steps = Math.round((PLATE_RANGE.most - PLATE_RANGE.least) / STEP);
  const levels = Array.from({ length: steps + 1 }, (_, i) => round(PLATE_RANGE.least + i * STEP));

  const score = (plate: Plate): number => {
    const held = { ...input.day };
    for (const part of [...MOVING_PARTS, 'rest'] as const) {
      const by = part === 'rest' ? 1 : plate[part];
      held.protein += input.parts[part].protein * by;
      held.fat += input.parts[part].fat * by;
      held.carbs += input.parts[part].carbs * by;
    }
    const shares = energyShares(held);
    if (!shares) return Number.POSITIVE_INFINITY;
    const away = MOVING_PARTS.reduce((sum, part) => sum + Math.abs(plate[part] - 1), 0) / STEP;
    return distanceOnDiet(shares, input.aim, input.dietType) + NEAR_THE_RECIPE * away;
  };

  // The part with the most energy takes what the others leave: it moves least for it.
  const last = moving.reduce((most, part) =>
    input.parts[part].calories > input.parts[most].calories ? part : most,
  );
  const free = moving.filter((part) => part !== last);
  const start = input.now && onTheRange(input.now) ? input.now : WHOLE_PLATE;
  let best: Plate = start;
  let bestScore = score(start);
  const baseline = bestScore;
  const visit = (index: number, plate: Plate): void => {
    if (index === free.length) {
      // The last part takes the energy the others leave.
      const others = free.reduce((sum, part) => sum + input.parts[part].calories * plate[part], 0);
      const lastCalories = input.parts[last].calories;
      const still = MOVING_PARTS.filter((part) => !moving.includes(part)).reduce(
        (sum, part) => sum + input.parts[part].calories,
        0,
      );
      const by = round((energy - others - still) / lastCalories);
      if (by < PLATE_RANGE.least - 1e-9 || by > PLATE_RANGE.most + 1e-9) return;
      const candidate = { ...plate, [last]: by };
      const value = score(candidate);
      if (value < bestScore - 1e-12) [best, bestScore] = [candidate, value];
      return;
    }
    for (const level of levels) visit(index + 1, { ...plate, [free[index]!]: level });
  };
  visit(0, WHOLE_PLATE);
  return baseline - bestScore >= WORTH ? best : start;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

const onTheRange = (plate: Plate): boolean =>
  MOVING_PARTS.every(
    (part) => plate[part] >= PLATE_RANGE.least - 1e-9 && plate[part] <= PLATE_RANGE.most + 1e-9,
  );

/** Whether a plate holds every part as the recipe has it. */
const isWholePlate = (plate: Plate): boolean =>
  MOVING_PARTS.every((part) => Math.abs(plate[part] - 1) < 1e-9);

/** How much of an ingredient of a part a plate holds against the recipe's proportion: one for the rest. */
export const shareOnPlate = (plate: Plate, part: PlatePart): number =>
  part === 'rest' ? 1 : plate[part];

/** The grams of fibre, sugars, salt and saturated fat a part is known to hold. */
export type PlateLabel = Record<'fiber' | 'sugars' | 'salt' | 'saturatedFat', number>;

/** A dish served on a plate, part by part: what a serving of each part holds, and the part of each ingredient. */
export interface PlateDish {
  parts: Record<PlatePart, PartFigures>;
  labels: Record<PlatePart, PlateLabel>;
  /** The part of each of its ingredients, by the ingredient's id. */
  partOf: ReadonlyMap<string, PlatePart>;
}

/** What a plate changes of a serving of its dish: its figures and the known grams of its label, the plate's less the recipe's. */
export function plateChange(
  dish: PlateDish,
  plate: Plate,
): { perServing: PartFigures; labelPerServing: PlateLabel } {
  const perServing = { calories: 0, protein: 0, fat: 0, carbs: 0 };
  const labelPerServing = { fiber: 0, sugars: 0, salt: 0, saturatedFat: 0 };
  for (const part of MOVING_PARTS) {
    const by = plate[part] - 1;
    for (const key of ['calories', 'protein', 'fat', 'carbs'] as const)
      perServing[key] += dish.parts[part][key] * by;
    for (const key of ['fiber', 'sugars', 'salt', 'saturatedFat'] as const)
      labelPerServing[key] += dish.labels[part][key] * by;
  }
  return { perServing, labelPerServing };
}

/** A shared meal of a day served on a plate: its row among the day's meals, its dish, and the plate it has now. */
export interface PlatePlace {
  mealId: string;
  dish: PlateDish;
  now?: Plate | null;
}

/**
 * The plates of a day's shared meals served on a plate, in the order given:
 * each the one that brings the person's day nearest its split (`plateOf`), the
 * meals before it on the plates chosen for them and the others as they are.
 * `meals` are the day's rows, those of the places as their recipes have them,
 * at the portions of `scales`; `aim` is what the day aims at, in grams. A
 * place whose plate is the recipe's own is left out.
 */
export function plateDay(
  meals: readonly RebalanceMeal[],
  scales: ReadonlyMap<string, number>,
  places: readonly PlatePlace[],
  aim: Macros,
  dietType: string,
): Map<string, Plate> {
  const plates = new Map<string, Plate>();
  const shares = energyShares(aim);
  if (!shares) return plates;
  const amountOf = (meal: RebalanceMeal): number =>
    meal.servings * (scales.get(meal.id) ?? meal.quantityScale);
  const placeOf = new Map(places.map((place) => [place.mealId, place]));
  for (const place of places) {
    const own = meals.find((meal) => meal.id === place.mealId);
    if (!own) continue;
    const day = { protein: 0, fat: 0, carbs: 0 };
    for (const meal of withPlates(
      meals.filter((meal) => meal !== own),
      plates,
      placeOf,
    )) {
      if (!meal.macros) continue;
      const amount = amountOf(meal);
      day.protein += meal.macros.protein * amount;
      day.fat += meal.macros.fat * amount;
      day.carbs += meal.macros.carbs * amount;
    }
    const amount = amountOf(own);
    const parts = Object.fromEntries(
      (Object.keys(place.dish.parts) as PlatePart[]).map((part) => {
        const figures = place.dish.parts[part];
        return [
          part,
          {
            calories: figures.calories * amount,
            protein: figures.protein * amount,
            fat: figures.fat * amount,
            carbs: figures.carbs * amount,
          },
        ];
      }),
    ) as Record<PlatePart, PartFigures>;
    const plate = plateOf({ parts, day, aim: shares, dietType, now: place.now ?? null });
    if (!isWholePlate(plate)) plates.set(place.mealId, plate);
  }
  return plates;
}

/** A day's rows with the changes of their plates in what a serving of each holds. */
export function withPlates(
  meals: readonly RebalanceMeal[],
  plates: ReadonlyMap<string, Plate>,
  places: ReadonlyMap<string, Pick<PlatePlace, 'dish'>>,
): RebalanceMeal[] {
  return meals.map((meal) => {
    const plate = plates.get(meal.id);
    const dish = places.get(meal.id)?.dish;
    if (!plate || !dish) return meal;
    const change = plateChange(dish, plate).perServing;
    return {
      ...meal,
      calories: meal.calories + change.calories,
      ...(meal.macros
        ? {
            macros: {
              protein: meal.macros.protein + change.protein,
              fat: meal.macros.fat + change.fat,
              carbs: meal.macros.carbs + change.carbs,
            },
          }
        : {}),
    };
  });
}
