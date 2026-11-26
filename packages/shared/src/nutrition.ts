// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { OWN_MEAL_LIMITS } from './constants.js';
import { KCAL_PER_GRAM } from './units.js';

/** Macronutrient triple, grams. Used for targets and totals alike. */
export const Macros = z.object({
  protein: z.number().min(0),
  fat: z.number().min(0),
  carbs: z.number().min(0),
});
export type Macros = z.infer<typeof Macros>;

/**
 * What a day aims at of protein, fat and carbohydrate, in grams, as a person
 * reads it. On a diet whose carbohydrate is a ceiling and not an aim (low-carb,
 * keto), `carbs` is that ceiling and `carbsFloor` the least the diet holds a
 * day to; `fat` is then what protein and the day's carbohydrate, kept inside
 * that band, leave of the energy. On the other diets `carbsFloor` is null.
 */
export const TargetMacros = Macros.extend({ carbsFloor: z.number().min(0).nullable() });
export type TargetMacros = z.infer<typeof TargetMacros>;

/** How much the protein, fat and carbohydrate of something change, in grams: under nothing for less. */
export const MacroChange = z.object({
  protein: z.number(),
  fat: z.number(),
  carbs: z.number(),
});
export type MacroChange = z.infer<typeof MacroChange>;

/**
 * The least and the most of a day's energy that somebody's own split may
 * give to protein, to fat and to carbohydrate, in per cent. Under the least
 * of protein and of fat a diet runs short of what a body cannot make itself;
 * the rest leaves room for every diet the application names and for more.
 */
export const SPLIT_SHARE_LIMITS = {
  protein: { min: 10, max: 45 },
  fat: { min: 15, max: 75 },
  carbs: { min: 5, max: 70 },
} as const;

/**
 * The custom diet's protein per kilogram of the body's weight, in grams: the
 * least and the most a profile may set, a tenth at a time, and where a form
 * starts. Fat keeps its share of the day and carbohydrate takes the rest,
 * every share inside `SPLIT_SHARE_LIMITS`.
 */
export const PROTEIN_PER_KG = { min: 0.8, max: 3, first: 1.6 } as const;

/**
 * The least and the most share of a day's energy, of one, that protein of
 * somebody's own split may have while fat keeps `fat` (a share of one) and
 * carbohydrate takes the rest: every share inside `SPLIT_SHARE_LIMITS`.
 */
export function proteinShareBounds(fat: number): { least: number; most: number } {
  return {
    least: Math.max(
      SPLIT_SHARE_LIMITS.protein.min / 100,
      1 - fat - SPLIT_SHARE_LIMITS.carbs.max / 100,
    ),
    most: Math.min(
      SPLIT_SHARE_LIMITS.protein.max / 100,
      1 - fat - SPLIT_SHARE_LIMITS.carbs.min / 100,
    ),
  };
}

/**
 * The grams of protein a kilogram of `weightKg` that keep every share inside
 * its limits at `target` kcal while fat keeps `fat` (a share of one): to a
 * tenth inward, inside `PROTEIN_PER_KG`; null where none do.
 */
export function proteinPerKgThatFits(
  fat: number,
  target: number,
  weightKg: number,
): { from: number; to: number } | null {
  const { least, most } = proteinShareBounds(fat);
  const perKg = (share: number) => (share * target) / KCAL_PER_GRAM.protein / weightKg;
  // A bound that is a tenth but for the error of floating point is that tenth.
  const from = Math.max(PROTEIN_PER_KG.min, Math.ceil(perKg(least) * 10 - 1e-9) / 10);
  const to = Math.min(PROTEIN_PER_KG.max, Math.floor(perKg(most) * 10 + 1e-9) / 10);
  return from <= to ? { from, to } : null;
}

/**
 * Somebody's own split of a day's energy between protein, fat and
 * carbohydrate: whole per cent that add up to a hundred.
 */
export const MacroSplit = z
  .object({
    protein: z
      .number()
      .int()
      .min(SPLIT_SHARE_LIMITS.protein.min)
      .max(SPLIT_SHARE_LIMITS.protein.max),
    fat: z.number().int().min(SPLIT_SHARE_LIMITS.fat.min).max(SPLIT_SHARE_LIMITS.fat.max),
    carbs: z.number().int().min(SPLIT_SHARE_LIMITS.carbs.min).max(SPLIT_SHARE_LIMITS.carbs.max),
  })
  .refine((split) => split.protein + split.fat + split.carbs === 100, {
    message: 'The three shares have to add up to 100.',
  });
export type MacroSplit = z.infer<typeof MacroSplit>;

/** A full nutrition snapshot — calories plus macros. */
export const Nutrition = Macros.extend({
  calories: z.number().min(0),
});
export type Nutrition = z.infer<typeof Nutrition>;

/** What a label gives besides energy and the macronutrients, in the order they are shown. */
export const LabelNutrient = z.enum(['fiber', 'sugars', 'salt', 'saturatedFat']);
export type LabelNutrient = z.infer<typeof LabelNutrient>;

/**
 * One of them as a sum, in grams: what its known parts add up to, and whether a part of it is not
 * known (a meal of one's own, an ingredient its source gives no figure for), so that there is at
 * least this much.
 */
export const LabelFigure = z.object({
  grams: z.number().min(0),
  atLeast: z.boolean(),
});
export type LabelFigure = z.infer<typeof LabelFigure>;

/** The fibre, sugars, salt and saturated fat of a serving, a meal or a day: null where nothing of it is known. */
export const LabelTotals = z.object({
  fiber: LabelFigure.nullable(),
  sugars: LabelFigure.nullable(),
  salt: LabelFigure.nullable(),
  saturatedFat: LabelFigure.nullable(),
});
export type LabelTotals = z.infer<typeof LabelTotals>;

/**
 * What a limit of a profile starts at when it is switched on: salt as the WHO advises, fibre as
 * EFSA finds adequate for an adult, saturated fat and sugars as the reference intakes of the EU's
 * labels give them (Regulation 1169/2011, Annex XIII), which count total sugars.
 */
export const LABEL_LIMIT_STARTS = {
  saltAtMost: 5,
  fiberAtLeast: 25,
  saturatedFatAtMost: 20,
  sugarsAtMost: 90,
} as const;

/** The least and the most each limit may be set to, in grams a day. */
export const LABEL_LIMIT_BOUNDS = {
  saltAtMost: { min: 1, max: 20 },
  fiberAtLeast: { min: 5, max: 80 },
  saturatedFatAtMost: { min: 5, max: 100 },
  sugarsAtMost: { min: 10, max: 300 },
} as const;

const labelLimit = (key: keyof typeof LABEL_LIMIT_BOUNDS) =>
  z.number().min(LABEL_LIMIT_BOUNDS[key].min).max(LABEL_LIMIT_BOUNDS[key].max).nullable();

/**
 * The limits a profile sets on a day's salt, sugars and saturated fat (at most) and fibre (at
 * least), each off (null) until it is set. A day that crosses one gets a note; the planner never
 * reads them.
 */
export const LabelLimits = z.object({
  saltAtMost: labelLimit('saltAtMost'),
  fiberAtLeast: labelLimit('fiberAtLeast'),
  saturatedFatAtMost: labelLimit('saturatedFatAtMost'),
  sugarsAtMost: labelLimit('sugarsAtMost'),
});
export type LabelLimits = z.infer<typeof LabelLimits>;

/** Every limit off: what a profile starts with. */
export const NO_LABEL_LIMITS: LabelLimits = {
  saltAtMost: null,
  fiberAtLeast: null,
  saturatedFatAtMost: null,
  sugarsAtMost: null,
};

/**
 * A limit of the profile that a day crossed: more than its most, or, with every part of the day
 * known, less than its least.
 */
export const LabelLimitNote = z.object({
  nutrient: LabelNutrient,
  kind: z.enum(['atMost', 'atLeast']),
  /** The limit as the profile sets it, in grams. */
  limit: z.number().min(0),
  /** What the day holds of it. */
  figure: LabelFigure,
});
export type LabelLimitNote = z.infer<typeof LabelLimitNote>;

/** The nutrition of one serving as somebody types it for a meal of their own, at most `OWN_MEAL_LIMITS.perServing`. */
export const EnteredNutrition = z.object({
  calories: z.number().min(0).max(OWN_MEAL_LIMITS.perServing.calories),
  protein: z.number().min(0).max(OWN_MEAL_LIMITS.perServing.protein),
  fat: z.number().min(0).max(OWN_MEAL_LIMITS.perServing.fat),
  carbs: z.number().min(0).max(OWN_MEAL_LIMITS.perServing.carbs),
});
export type EnteredNutrition = z.infer<typeof EnteredNutrition>;

/**
 * The least a calorie target somebody types may be, for a profile, a plan or a
 * day: under it a day of ordinary food hardly holds what the body needs, and a
 * diet that low belongs to a specialist service. A body whose maintenance is
 * lower still may type its maintenance (`CalorieCalculation.leastTypedTarget`).
 */
export const MIN_CALORIE_TARGET = 1200;
/**
 * The least any calorie target is held to: what a request may carry, what a
 * day kept from before the least above may hold, and what a rest day of a
 * typed target may come to, its week holding the target.
 */
export const LOWEST_CALORIE_TARGET = 800;
/** The most a calorie target somebody types may be. */
export const MAX_CALORIE_TARGET = 6000;

/**
 * What a client should tell the user about a calorie target:
 *
 *  - `minor`: under 18. The equation behind the figures is one for adults,
 *    so they are an approximation, and no loss is planned;
 *  - `underweight`: a body-mass index under 18.5, for which no loss is planned;
 *  - `older`: 65 or older at a body-mass index under 30, where the guidelines
 *    for older people advise against losing weight; the pace stays the
 *    person's choice;
 *  - `below_floor`: a target somebody typed is under the lowest a calculated
 *    one goes;
 *  - `below_bmr`: the target is under what the body uses at rest.
 */
export const CalorieWarning = z.enum(['minor', 'underweight', 'older', 'below_floor', 'below_bmr']);
export type CalorieWarning = z.infer<typeof CalorieWarning>;

/** Under this age the equation behind the figures is an approximation, and no loss is planned. */
export const ADULT_AGE = 18;
/** A body-mass index under this is underweight. */
export const UNDERWEIGHT_BMI = 18.5;
/** From this age the paces of loss are the two slower ones. */
export const OLDER_AGE = 65;
/** From 65, under this body-mass index the guidelines for older people advise against losing weight. */
export const OLDER_LOSS_BMI = 30;

/**
 * Why losing weight is a risk for this body: under 18, underweight, both or
 * neither. Where it is, no loss is planned: a pace counts as none and a typed
 * target under maintenance is held at maintenance.
 */
export function riskOfLosingWeight(body: {
  age: number;
  heightCm: number;
  weightKg: number;
}): ('minor' | 'underweight')[] {
  const bmi = body.weightKg / (body.heightCm / 100) ** 2;
  return [
    ...(body.age < ADULT_AGE ? (['minor'] as const) : []),
    ...(bmi < UNDERWEIGHT_BMI ? (['underweight'] as const) : []),
  ];
}

/**
 * Result of the deterministic calorie engine. Every field is reproducible from
 * profile inputs; `source` tags whether the daily target was derived or
 * manually overridden so the UI can explain it.
 */
export const CalorieCalculation = z.object({
  bmr: z.number(), // Mifflin-St Jeor basal metabolic rate
  maintenance: z.number(), // bmr * activity multiplier (TDEE)
  weeklyLossTarget: z.enum(['0.25', '0.5', '0.75', '1.0']).nullable(),
  /** kcal a day the chosen pace asks for, before any limit. */
  requestedDeficit: z.number(),
  /** How far the target really is under maintenance; negative when a typed target is above it. */
  dailyDeficit: z.number(),
  /**
   * What that deficit loses at first, in kilograms a week, to the hundredth (7700 kcal a kilogram); nothing for a
   * target at or over maintenance. A body loses less as it goes on: the figure is the start.
   */
  weeklyLossKg: z.number().min(0),
  dailyTarget: z.number(), // final calorie target
  targetMacros: TargetMacros,
  source: z.enum(['calculated', 'manual_override']),
  /** The lowest a calculated target goes for this profile. */
  safetyFloor: z.number(),
  /**
   * The pace asked for more than a quarter of maintenance, or for more than 1 % of the body's weight a week,
   * and was slowed to the lesser of the two.
   */
  deficitCapped: z.boolean(),
  /** From 65 the pace chosen is one of the two faster ones, and counts as 0.5 kg a week. */
  paceHeldForAge: z.boolean(),
  /** The target was raised to the floor. */
  safetyFloorApplied: z.boolean(),
  /** Maintenance itself is under the floor: no loss is planned, the target is maintenance. */
  maintenanceUnderFloor: z.boolean(),
  /**
   * The profile asks to lose weight and is under 18 or underweight: no loss is
   * planned, and the target is held at maintenance (the greater of the
   * formula's and the one the real expenditure corrected) for as long as the
   * body is so.
   */
  goalHeld: z.boolean(),
  /**
   * The correction from the real expenditure would take a target nobody typed
   * under what the body uses at rest, under the floor where the formula's
   * maintenance reaches it, or, for a body under 18 or underweight, under the
   * formula's maintenance: the target is held there.
   */
  correctionHeld: z.boolean(),
  /**
   * The least a target this body types may be: `MIN_CALORIE_TARGET`, or the
   * formula's maintenance where that is lower.
   */
  leastTypedTarget: z.number(),
  /**
   * The custom diet's protein per kilogram came to a share of the day outside
   * the limits of a split, and the targets hold it at the limit: the profile
   * says so. False on every other diet and way.
   */
  customSplitHeld: z.boolean(),
  warnings: z.array(CalorieWarning),
});
export type CalorieCalculation = z.infer<typeof CalorieCalculation>;
