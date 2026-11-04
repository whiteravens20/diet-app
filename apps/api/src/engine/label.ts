// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { KCAL_PER_GRAM, type Macros } from '@diet-app/shared';
import { filledMacros } from './nutrition.js';

/** A label's figures as a source words them, in 100 g or ml: numbers, and null where it gives none. */
export interface LabelReading {
  kcal: number | null;
  kj: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fiber: number | null;
  sugars: number | null;
  salt: number | null;
  sodium: number | null;
  saturatedFat: number | null;
  alcohol: number | null;
  polyols: number | null;
}

/** What a label says beside energy and the macronutrients. */
interface LabelNutrientFigures {
  fiber: number | null;
  sugars: number | null;
  salt: number | null;
  saturatedFat: number | null;
}

/** A label's figures as the instance keeps them: null where it says nothing that can be right. */
export interface LabelFigures extends LabelNutrientFigures {
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  /** The label gives no energy: the figure is worked out from its macronutrients. */
  energyWorkedOut: boolean;
  /** The figures do not add up, or one of them cannot be right. */
  doubtful: boolean;
}

/** Pure fat: nothing that is eaten holds more in 100 g. */
const MOST_KCAL_PER_100 = 900;
const KJ_PER_KCAL = 4.184;
/** What a gram of sodium comes to as salt, as a label reckons it. */
const SALT_PER_SODIUM = 2.5;
/** The three macronutrients in 100 g, with what the rounding of a label can add. */
const MOST_MACROS_PER_100 = 105;

/** The energy of what a label counts besides the three macronutrients, in kcal a gram, as EU labels reckon it. */
const KCAL_A_GRAM_BESIDES = { alcohol: 7, polyols: 2.4, fiber: 2 } as const;

/**
 * How far the energy a label states may lie from what its figures come to
 * before they are taken not to add up: both of these at once. A label rounds,
 * and counts some carbohydrates at less than four kilocalories a gram.
 */
const ENERGY_SLACK = { kcal: 40, share: 0.2 };

const hundredths = (value: number): number => Math.round(value * 100) / 100;

/** A number that can be right, otherwise null. */
const within = (value: number | null, most: number): number | null =>
  value !== null && value >= 0 && value <= most ? value : null;

/**
 * What a label's figures come to, as far as they can be right. A figure that
 * cannot be (over 100 g in 100 g, over 900 kcal) counts as unknown, never as a
 * number. An energy that cannot be right gives way to the kilojoules, or to
 * what the macronutrients come to, and the figures are then judged as they
 * stand; a macronutrient that cannot be right leaves a gap that is estimated,
 * and the product is marked as doubtful. So is one whose energy lies too far
 * from what its figures come to. Where the energy is worked out from the
 * macronutrients, the label says so.
 */
export function readLabel(raw: LabelReading): LabelFigures {
  const kcal = within(raw.kcal, MOST_KCAL_PER_100);
  const fromKj = within(raw.kj, MOST_KCAL_PER_100 * KJ_PER_KCAL);
  const energy = kcal ?? (fromKj === null ? null : fromKj / KJ_PER_KCAL);

  const grams = (value: number | null): number | null => within(value, 100);
  let protein = grams(raw.protein);
  let fat = grams(raw.fat);
  let carbs = grams(raw.carbs);
  let macrosWrong = [
    [raw.protein, protein],
    [raw.fat, fat],
    [raw.carbs, carbs],
  ].some(([given, kept]) => given !== null && kept === null);
  if ((protein ?? 0) + (fat ?? 0) + (carbs ?? 0) > MOST_MACROS_PER_100) {
    protein = fat = carbs = null;
    macrosWrong = true;
  }

  const fiber = grams(raw.fiber);
  const saltGiven = grams(raw.salt);
  const sodium = grams(raw.sodium);
  const salt = saltGiven ?? (sodium === null ? null : grams(sodium * SALT_PER_SODIUM));
  const allMacros = protein !== null && fat !== null && carbs !== null;

  let calories = energy;
  let energyWorkedOut = false;
  let apart = false;
  if (allMacros) {
    const worked = kcalFromLabel(protein!, fat!, carbs!, {
      alcohol: grams(raw.alcohol) ?? 0,
      polyols: grams(raw.polyols) ?? 0,
      fiber: fiber ?? 0,
    });
    if (calories === null) {
      calories = worked;
      energyWorkedOut = true;
    } else {
      const gap = Math.abs(calories - worked);
      apart = gap > ENERGY_SLACK.kcal && gap / Math.max(calories, worked, 1) > ENERGY_SLACK.share;
    }
  }

  const rounded = (value: number | null): number | null =>
    value === null ? null : hundredths(value);
  return {
    calories: rounded(calories),
    protein: rounded(protein),
    fat: rounded(fat),
    carbs: rounded(carbs),
    fiber: rounded(fiber),
    sugars: rounded(grams(raw.sugars)),
    salt: rounded(salt),
    saturatedFat: rounded(grams(raw.saturatedFat)),
    energyWorkedOut,
    doubtful: macrosWrong || apart,
  };
}

/** What the macronutrients of a label come to, with what it counts beside them; a label's carbohydrates hold its polyols. */
function kcalFromLabel(
  protein: number,
  fat: number,
  carbs: number,
  besides: { alcohol: number; polyols: number; fiber: number },
): number {
  const polyols = Math.min(besides.polyols, carbs);
  return (
    protein * KCAL_PER_GRAM.protein +
    fat * KCAL_PER_GRAM.fat +
    (carbs - polyols) * KCAL_PER_GRAM.carbs +
    polyols * KCAL_A_GRAM_BESIDES.polyols +
    besides.alcohol * KCAL_A_GRAM_BESIDES.alcohol +
    besides.fiber * KCAL_A_GRAM_BESIDES.fiber
  );
}

/** What an amount of a product comes to, with what it says beside them. */
export interface LabelEntryFigures extends LabelNutrientFigures {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  /** Its energy was worked out, or a macronutrient its label lacks was estimated. */
  estimated: boolean;
}

/**
 * What `quantity` of a product comes to, in the unit its figures are given in.
 * Without its energy it cannot be counted, and this is null. A macronutrient
 * its label lacks is estimated from what is left of the energy, in the
 * proportions `split` gives; what the label does give stands as it is, even
 * where it does not add up.
 */
export function labelEntryFigures(
  label: Omit<LabelFigures, 'doubtful'>,
  quantity: number,
  split: Macros,
): LabelEntryFigures | null {
  if (label.calories === null) return null;
  const known: Partial<Macros> = {
    ...(label.protein === null ? {} : { protein: label.protein }),
    ...(label.fat === null ? {} : { fat: label.fat }),
    ...(label.carbs === null ? {} : { carbs: label.carbs }),
  };
  const lacking = label.protein === null || label.fat === null || label.carbs === null;
  const macros = filledMacros(label.calories, known, split);
  const factor = quantity / 100;
  const scaled = (value: number | null): number | null => (value === null ? null : value * factor);
  return {
    calories: label.calories * factor,
    protein: macros.protein * factor,
    fat: macros.fat * factor,
    carbs: macros.carbs * factor,
    fiber: scaled(label.fiber),
    sugars: scaled(label.sugars),
    salt: scaled(label.salt),
    saturatedFat: scaled(label.saturatedFat),
    estimated: lacking || label.energyWorkedOut,
  };
}
