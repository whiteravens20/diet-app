/**
 * Deterministic calorie & macro engine.
 *
 * Every function here is pure and unit-tested. Results are reproducible from
 * profile inputs alone — no randomness, no AI, no I/O. This is the contract
 * behind product principle #3 ("all calorie/macro calculations deterministic").
 */
import type { ActivityLevel, CalorieCalculation, DietType, Macros, Sex } from '@diet-app/shared';

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
export const KCAL_PER_GRAM = { protein: 4, fat: 9, carbs: 4 } as const;

/**
 * Macro split per diet type, as fractions of total daily calories.
 * Order: protein / fat / carbs. Each row sums to 1.0.
 */
const MACRO_SPLIT: Record<DietType, Macros> = {
  balanced: { protein: 0.25, fat: 0.3, carbs: 0.45 },
  high_protein: { protein: 0.4, fat: 0.3, carbs: 0.3 },
  low_carb: { protein: 0.35, fat: 0.4, carbs: 0.25 },
  vegetarian: { protein: 0.22, fat: 0.3, carbs: 0.48 },
  vegan: { protein: 0.2, fat: 0.28, carbs: 0.52 },
  keto: { protein: 0.25, fat: 0.7, carbs: 0.05 },
  mediterranean: { protein: 0.22, fat: 0.37, carbs: 0.41 },
  custom: { protein: 0.25, fat: 0.3, carbs: 0.45 },
};

export interface CalorieEngineInput {
  age: number;
  sex: Sex | null;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  dietType: DietType;
  weeklyLossTarget: '0.25' | '0.5' | '0.75' | '1.0' | null;
  manualCalorieTarget: number | null;
}

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

/** Minimum safe daily calories — clamps aggressive deficits. */
function safetyFloor(sex: Sex | null): number {
  return sex === 'male' ? 1500 : 1200;
}

/** Split a calorie target into target macros (grams) for a diet type. */
export function macrosForCalories(calories: number, dietType: DietType): Macros {
  const split = MACRO_SPLIT[dietType];
  return {
    protein: round((calories * split.protein) / KCAL_PER_GRAM.protein),
    fat: round((calories * split.fat) / KCAL_PER_GRAM.fat),
    carbs: round((calories * split.carbs) / KCAL_PER_GRAM.carbs),
  };
}

/**
 * Full deterministic calorie calculation. A manual override always wins and is
 * tagged as such; otherwise the target is maintenance minus the weekly-target
 * deficit, clamped to the safety floor.
 */
export function calculateCalories(input: CalorieEngineInput): CalorieCalculation {
  const bmr = calculateBmr(input);
  const maintenance = calculateMaintenance(bmr, input.activityLevel);
  const dailyDeficit = deficitForWeeklyTarget(input.weeklyLossTarget);

  let dailyTarget: number;
  let source: CalorieCalculation['source'];
  let safetyFloorApplied = false;

  if (input.manualCalorieTarget !== null) {
    dailyTarget = input.manualCalorieTarget;
    source = 'manual_override';
  } else {
    const floor = safetyFloor(input.sex);
    const raw = maintenance - dailyDeficit;
    dailyTarget = Math.max(raw, floor);
    safetyFloorApplied = raw < floor;
    source = 'calculated';
  }

  return {
    bmr,
    maintenance,
    weeklyLossTarget: input.weeklyLossTarget,
    dailyDeficit,
    dailyTarget: round(dailyTarget),
    targetMacros: macrosForCalories(dailyTarget, input.dietType),
    source,
    safetyFloorApplied,
  };
}

/** Round to whole numbers — calorie/macro outputs are always integers. */
function round(n: number): number {
  return Math.round(n);
}

/**
 * F17 periodisation factors: a training day runs a surplus and a rest day a
 * deficit relative to the plan's base target, so tagging a day actually shapes
 * its calories. Defaults are ±15%; a user-supplied per-day calorie override
 * always wins over these (handled by the caller).
 */
export const TRAINING_DAY_FACTOR = 1.15;
export const REST_DAY_FACTOR = 0.85;

/**
 * Resolve a day's calorie target from its base target and semantic day type.
 * `training` adds the surplus, `rest` applies the deficit; anything else (incl.
 * `normal`/undefined) returns the base unchanged. Result rounded to a tidy 10.
 */
export function dayTypeCalorieTarget(
  baseTarget: number,
  dayType: 'normal' | 'rest' | 'training' | undefined,
): number {
  const factor = dayType === 'training' ? TRAINING_DAY_FACTOR : dayType === 'rest' ? REST_DAY_FACTOR : 1;
  return Math.round((baseTarget * factor) / 10) * 10;
}
