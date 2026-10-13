// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Deterministic calorie & macro engine.
 *
 * Every function here is pure and unit-tested. Results are reproducible from
 * profile inputs alone — no randomness, no AI, no I/O: every calorie and macro
 * calculation is deterministic.
 */
import { MIN_CALORIE_TARGET, riskOfLosingWeight, type ActivityLevel, type CalorieCalculation, type DietType, type Macros, type Sex } from '@diet-app/shared';

/** Mifflin-St Jeor activity multipliers (BMR → TDEE / maintenance). */
const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** Energy density of body fat — 1 kg ≈ 7700 kcal. */
const KCAL_PER_KG_FAT = 7700;

/** kcal in 1 g of each macronutrient (Atwater factors). */
const KCAL_PER_GRAM = { protein: 4, fat: 9, carbs: 4 } as const;

/**
 * Macro split per diet type, as fractions of total daily calories.
 * Order: protein / fat / carbs. Each row sums to 1.0.
 *
 * The low-carbohydrate day takes a fifth of its energy from carbohydrate:
 * inside what the nutrition literature calls low-carbohydrate (under 26 %)
 * with room on both sides, and above what it calls ketogenic (under 10 %).
 * Its protein stays inside the 10 to 35 % the reference intakes give for
 * protein, and fat carries the rest.
 */
const MACRO_SPLIT: Record<DietType, Macros> = {
  balanced: { protein: 0.25, fat: 0.3, carbs: 0.45 },
  high_protein: { protein: 0.4, fat: 0.3, carbs: 0.3 },
  low_carb: { protein: 0.3, fat: 0.5, carbs: 0.2 },
  vegetarian: { protein: 0.22, fat: 0.3, carbs: 0.48 },
  vegan: { protein: 0.2, fat: 0.28, carbs: 0.52 },
  keto: { protein: 0.25, fat: 0.7, carbs: 0.05 },
  mediterranean: { protein: 0.22, fat: 0.37, carbs: 0.41 },
  custom: { protein: 0.25, fat: 0.3, carbs: 0.45 },
};

/** A split in whole per cent, as a profile keeps it, as the shares of one the engine works with; null stays null. */
export function sharesOf(split: Macros | null | undefined): Macros | null {
  return split ? { protein: split.protein / 100, fat: split.fat / 100, carbs: split.carbs / 100 } : null;
}

export interface CalorieEngineInput {
  age: number;
  sex: Sex | null;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  dietType: DietType;
  /** The shares the custom diet aims at, when the profile has said them. */
  customMacroSplit?: Macros | null;
  weeklyLossTarget: '0.25' | '0.5' | '0.75' | '1.0' | null;
  manualCalorieTarget: number | null;
  /** Whether a profile that is under 18 or underweight has said it understands the risk of losing weight. */
  riskAcknowledged: boolean;
}

/** The most of maintenance a pace of loss may take away each day. */
const MAX_DEFICIT_SHARE = 0.25;

/**
 * Basal Metabolic Rate via Mifflin-St Jeor.
 * Sex offset: +5 male, -161 female. When sex is unknown we use the midpoint
 * (-78) so the estimate is unbiased rather than defaulting to one sex.
 */
export function calculateBmr(input: Pick<CalorieEngineInput, 'age' | 'sex' | 'heightCm' | 'weightKg'>): number {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  const sexOffset = input.sex === 'male' ? 5 : input.sex === 'female' ? -161 : -78;
  return round(base + sexOffset);
}

/** Maintenance calories (TDEE) = BMR × activity multiplier. */
export function calculateMaintenance(bmr: number, activityLevel: ActivityLevel): number {
  return round(bmr * ACTIVITY_MULTIPLIER[activityLevel]);
}

/** Daily kcal deficit implied by a weekly fat-loss target. */
export function deficitForWeeklyTarget(target: CalorieEngineInput['weeklyLossTarget']): number {
  if (target === null) return 0;
  return round((Number(target) * KCAL_PER_KG_FAT) / 7);
}

/** The lowest a calculated target goes. */
export function safetyFloor(sex: Sex | null): number {
  return sex === 'male' ? 1500 : 1200;
}

/** The split of a day's energy that a diet aims at, as shares that add up to one. */
export function macroSplitOf(dietType: DietType, own?: Macros | null): Macros {
  // The custom diet aims at what its profile said, and at the balanced split until one has.
  return dietType === 'custom' && own ? own : MACRO_SPLIT[dietType];
}

/** The share of their energy that protein, fat and carbohydrate each carry; null when they hold none. */
export function energyShares(grams: Macros): Macros | null {
  const protein = grams.protein * KCAL_PER_GRAM.protein;
  const fat = grams.fat * KCAL_PER_GRAM.fat;
  const carbs = grams.carbs * KCAL_PER_GRAM.carbs;
  const total = protein + fat + carbs;
  return total > 0 ? { protein: protein / total, fat: fat / total, carbs: carbs / total } : null;
}

/** How far one split is from another: the share of the energy that would have to move, from 0 to 1. */
export function splitDistance(a: Macros, b: Macros): number {
  return (Math.abs(a.protein - b.protein) + Math.abs(a.fat - b.fat) + Math.abs(a.carbs - b.carbs)) / 2;
}

/** Split a calorie target into target macros (grams) for a diet type; `own` is the split of the custom diet. */
export function macrosForCalories(calories: number, dietType: DietType, own?: Macros | null): Macros {
  const split = macroSplitOf(dietType, own);
  return {
    protein: round((calories * split.protein) / KCAL_PER_GRAM.protein),
    fat: round((calories * split.fat) / KCAL_PER_GRAM.fat),
    carbs: round((calories * split.carbs) / KCAL_PER_GRAM.carbs),
  };
}

/**
 * The calorie target of a profile, with everything a client needs to explain
 * it.
 *
 * A calculated target is maintenance less the deficit of the chosen pace.
 * The deficit is at most a quarter of maintenance; the target is never under
 * the floor, and never above maintenance: where maintenance itself is under
 * the floor, no loss is planned. A target somebody typed is taken as it is,
 * and flagged when it is under the floor or under the basal rate.
 *
 * Somebody under 18 or underweight who asks to lose weight (by a pace, or by
 * a typed target under maintenance) is planned maintenance until they have
 * said they understand the risk.
 */
export function calculateCalories(input: CalorieEngineInput): CalorieCalculation {
  const bmr = calculateBmr(input);
  const maintenance = calculateMaintenance(bmr, input.activityLevel);
  const requestedDeficit = deficitForWeeklyTarget(input.weeklyLossTarget);
  const floor = safetyFloor(input.sex);
  const manual = input.manualCalorieTarget;
  const source: CalorieCalculation['source'] = manual === null ? 'calculated' : 'manual_override';

  const atRisk = riskOfLosingWeight(input);
  const asksForLoss = manual === null ? requestedDeficit > 0 : manual < maintenance;
  const goalHeld = atRisk.length > 0 && asksForLoss && !input.riskAcknowledged;

  let dailyTarget: number;
  let deficitCapped = false;
  let safetyFloorApplied = false;
  let maintenanceUnderFloor = false;
  if (goalHeld) {
    dailyTarget = maintenance;
  } else if (manual !== null) {
    dailyTarget = manual;
  } else {
    const most = round(maintenance * MAX_DEFICIT_SHARE);
    deficitCapped = requestedDeficit > most;
    const paced = maintenance - Math.min(requestedDeficit, most);
    maintenanceUnderFloor = maintenance < floor;
    safetyFloorApplied = !maintenanceUnderFloor && paced < floor;
    dailyTarget = maintenanceUnderFloor ? maintenance : Math.max(paced, floor);
  }
  dailyTarget = round(dailyTarget);

  return {
    bmr,
    maintenance,
    weeklyLossTarget: input.weeklyLossTarget,
    requestedDeficit,
    dailyDeficit: maintenance - dailyTarget,
    dailyTarget,
    targetMacros: macrosForCalories(dailyTarget, input.dietType, input.customMacroSplit),
    source,
    safetyFloor: floor,
    deficitCapped,
    safetyFloorApplied,
    maintenanceUnderFloor,
    goalHeld,
    warnings: [
      ...atRisk,
      ...(source === 'manual_override' && dailyTarget < floor ? (['below_floor'] as const) : []),
      ...(dailyTarget < bmr ? (['below_bmr'] as const) : []),
    ],
  };
}

/** Round to whole numbers — calorie/macro outputs are always integers. */
function round(n: number): number {
  return Math.round(n);
}

/**
 * Periodisation factors: a training day runs a surplus and a rest day a
 * deficit relative to the plan's base target, so tagging a day actually shapes
 * its calories. Defaults are ±15%.
 */
const TRAINING_DAY_FACTOR = 1.15;
const REST_DAY_FACTOR = 0.85;

/** The kind of day a plan day is: it shapes the day's target. */
export type DayType = 'normal' | 'rest' | 'training';

/**
 * The calorie target of one day of a plan. The one place where it is decided.
 *
 *  - A target the user set for that day is taken as it is, unless the
 *    profile's loss goal is held and the target is under maintenance.
 *  - Otherwise the plan's base is shaped by the kind of day and rounded to
 *    ten. When the base was calculated, a rest day does not take it under the
 *    floor (nor under the base itself, where that is under the floor already).
 *    When somebody typed the base, the day follows it down, but never under
 *    the least a typed target may be.
 *
 * `belowFloor` says that a target somebody typed, for the plan or for the
 * day, has put the day under the floor.
 */
export function effectiveDayTarget(day: {
  base: number;
  /** Whether the engine calculated the base, or somebody typed it (on the profile or for the plan). */
  baseIsCalculated: boolean;
  floor: number;
  dayType?: DayType;
  /** The target the user set for this day. */
  ownTarget?: number | null;
  /** Maintenance, for a profile whose loss goal is held: a day's own target under it is not taken. */
  holdUnder?: number | null;
}): { target: number; belowFloor: boolean } {
  const own = day.ownTarget ?? null;
  const held = own !== null && day.holdUnder != null && own < day.holdUnder;
  if (own !== null && !held) return { target: own, belowFloor: own < day.floor };
  const factor = day.dayType === 'training' ? TRAINING_DAY_FACTOR : day.dayType === 'rest' ? REST_DAY_FACTOR : 1;
  const shaped = Math.round((day.base * factor) / 10) * 10;
  const least = day.baseIsCalculated ? Math.min(day.floor, day.base) : MIN_CALORIE_TARGET;
  const target = Math.max(shaped, least);
  return { target, belowFloor: !day.baseIsCalculated && target < day.floor };
}
