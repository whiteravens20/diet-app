// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The energy and the three macronutrients of an imported food, per 100 g.
 *
 * The source does not report every food the same way: newer records leave out
 * "carbohydrate by difference" or the plain energy figure and carry the same
 * quantity under another number. Each value is read from the first number it
 * is found under. A food that lacks a macronutrient under every number is not
 * imported: stored as zero it would look like a food without carbohydrate and
 * make every recipe that uses it wrong. Nor is one whose figures contradict
 * each other.
 *
 * A fat is the exception. The source reports an oil's fat and nothing else,
 * and butter's fat and water, because there is next to nothing else in them:
 * butter holds under a gram of protein in a hundred. What is fat for four
 * fifths of its weight or more is taken with no protein and no carbohydrate
 * where the record names none.
 */

import { PART_SLACK } from '@diet-app/shared';

/** One nutrient of a food, in any of the shapes the source's endpoints use. */
export interface SourceNutrient {
  nutrientNumber?: string;
  value?: number;
  number?: string;
  amount?: number;
  nutrient?: { number?: string };
}

export interface Macros {
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
}

/** The numbers each value may be reported under, in order of preference. */
const NUMBERS = {
  protein: ['203'],
  // total lipid, else total fat as on a nutrition label
  fat: ['204', '298'],
  // carbohydrate by difference, else by summation
  carbs: ['205', '205.2'],
  // energy in kcal, else worked out by the source with general or specific factors
  energy: ['208', '957', '958'],
} as const;

/** From this much fat in 100 g on, a food is a fat: an oil, butter, lard. */
const FAT_AND_LITTLE_ELSE = 80;

const round = (value: number): number => Math.max(0, Math.round(value * 10) / 10);

function read(nutrients: readonly SourceNutrient[], numbers: readonly string[]): number | null {
  for (const number of numbers) {
    const found = nutrients.find(
      (n) => (n.nutrientNumber ?? n.number ?? n.nutrient?.number) === number,
    );
    const raw = found?.value ?? found?.amount;
    if (typeof raw === 'number' && Number.isFinite(raw)) return round(raw);
  }
  return null;
}

/** The energy the three macronutrients account for, at 4, 9 and 4 kcal per gram. */
const fromMacros = (protein: number, fat: number, carbs: number): number =>
  round(protein * 4 + fat * 9 + carbs * 4);

/**
 * The values of a food, or why it cannot be imported. Energy that the source
 * does not state is worked out from the macronutrients, which is what the
 * source's own general factors do.
 */
export function macrosOf(nutrients: readonly SourceNutrient[]): Macros | { refused: string } {
  const fat = read(nutrients, NUMBERS.fat);
  const isFat = fat !== null && fat >= FAT_AND_LITTLE_ELSE;
  const protein = read(nutrients, NUMBERS.protein) ?? (isFat ? 0 : null);
  const carbs = read(nutrients, NUMBERS.carbs) ?? (isFat ? 0 : null);
  const missing = [
    protein === null && 'protein',
    fat === null && 'fat',
    carbs === null && 'carbohydrate',
  ].filter(Boolean);
  if (protein === null || fat === null || carbs === null)
    return { refused: `no value for ${missing.join(', ')}` };

  const expected = fromMacros(protein, fat, carbs);
  const energy = read(nutrients, NUMBERS.energy) ?? expected;
  if (energy === 0) return { refused: 'no energy' };
  if (protein + fat + carbs > 100.5) {
    return {
      refused: `protein, fat and carbohydrate add up to ${round(protein + fat + carbs)} g in 100 g`,
    };
  }
  // Fibre and rounding explain small gaps; alcohol or a wrong figure a large one.
  const gap = Math.abs(energy - expected);
  if (gap > Math.max(10, energy * 0.15)) {
    return {
      refused: `${energy} kcal stated, ${expected} kcal from its protein, fat and carbohydrate`,
    };
  }
  return { caloriesPer100: energy, proteinPer100: protein, fatPer100: fat, carbsPer100: carbs };
}

/** What a label gives besides, in 100 g: each left out where the source does not report it. */
export interface LabelFigures {
  fiberPer100?: number;
  sugarsPer100?: number;
  saltPer100?: number;
  saturatedFatPer100?: number;
}

/** The numbers each of them may be reported under, in order of preference. */
const LABEL_NUMBERS = {
  // total dietary fibre
  fiber: ['291'],
  // total sugars, under either of the source's numbers for them
  sugars: ['269', '269.3'],
  // sodium in milligrams: a label gives salt, 2.5 times its weight
  sodium: ['307'],
  // total saturated fatty acids
  saturatedFat: ['606'],
} as const;

/**
 * The fibre, sugars, salt and saturated fat of a food that is imported, per 100 g. A figure that
 * contradicts the macronutrients (more sugars than carbohydrate, more saturated fat than fat) is
 * left out like one the source does not report: the food itself is still taken.
 */
export function labelOf(nutrients: readonly SourceNutrient[], macros: Macros): LabelFigures {
  const fiber = read(nutrients, LABEL_NUMBERS.fiber);
  const sugars = read(nutrients, LABEL_NUMBERS.sugars);
  const sodium = read(nutrients, LABEL_NUMBERS.sodium);
  const saturatedFat = read(nutrients, LABEL_NUMBERS.saturatedFat);
  // Salt in grams to two places, from sodium in milligrams.
  const salt = sodium === null ? null : Math.round((sodium * 2.5) / 10) / 100;
  return {
    ...(fiber !== null && fiber <= 100 ? { fiberPer100: fiber } : {}),
    ...(sugars !== null && sugars <= macros.carbsPer100 + PART_SLACK
      ? { sugarsPer100: sugars }
      : {}),
    ...(salt !== null && salt <= 100 ? { saltPer100: salt } : {}),
    ...(saturatedFat !== null && saturatedFat <= macros.fatPer100 + PART_SLACK
      ? { saturatedFatPer100: saturatedFat }
      : {}),
  };
}
