// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Deterministic calorie & macro engine.
 *
 * Every function here is pure and unit-tested. Results are reproducible from
 * profile inputs alone — no randomness, no AI, no I/O: every calorie and macro
 * calculation is deterministic.
 */
import {
  ADULT_AGE,
  KCAL_PER_GRAM,
  LOWEST_CALORIE_TARGET,
  MIN_CALORIE_TARGET,
  OLDER_AGE,
  OLDER_FASTEST_PACE_KG,
  OLDER_LOSS_BMI,
  proteinShareBounds,
  riskOfLosingWeight,
  type ActivityLevel,
  type CalorieCalculation,
  type DietType,
  type Macros,
  type Sex,
  type TargetMacros,
} from '@diet-app/shared';

/**
 * The physical activity levels that turn the resting figure into maintenance:
 * those of EFSA's reference values for energy (2013), resting energy times
 * 1.4 for a sedentary (low active) life, 1.6 moderately active, 1.8 active and
 * 2.0 very active, with light activity between the first two. FAO/WHO/UNU
 * (2004) give 1.40–1.69 for a sedentary or light lifestyle. The old
 * calculators' 1.2 describes somebody who hardly moves at all, and planned a
 * sedentary person's loss on a maintenance a seventh too low.
 */
const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.4,
  light: 1.5,
  moderate: 1.6,
  active: 1.8,
  very_active: 2.0,
};

/** Energy density of body fat — 1 kg ≈ 7700 kcal. */
export const KCAL_PER_KG_FAT = 7700;

/**
 * Macro split per diet type, as fractions of total daily calories.
 * Order: protein / fat / carbs. Each row sums to 1.0.
 *
 * The low-carbohydrate day takes a tenth to a fifth of its energy from
 * carbohydrate: inside what the nutrition literature calls low-carbohydrate
 * (under 26 %), and above what it calls ketogenic (under 10 %). The ketogenic
 * day takes at most a twentieth. For both the share is a ceiling
 * (`carbFloor`), and a day under it, and over low-carb's floor, is held to
 * its protein alone. Protein stays inside the 10 to 35 % the reference intakes give for
 * protein, and fat carries the rest. The high-protein day stands at the top
 * of that range and no higher.
 */
const MACRO_SPLIT: Record<DietType, Macros> = {
  balanced: { protein: 0.25, fat: 0.3, carbs: 0.45 },
  high_protein: { protein: 0.35, fat: 0.3, carbs: 0.35 },
  low_carb: { protein: 0.3, fat: 0.5, carbs: 0.2 },
  vegetarian: { protein: 0.22, fat: 0.3, carbs: 0.48 },
  vegan: { protein: 0.2, fat: 0.28, carbs: 0.52 },
  keto: { protein: 0.25, fat: 0.7, carbs: 0.05 },
  mediterranean: { protein: 0.22, fat: 0.37, carbs: 0.41 },
  custom: { protein: 0.25, fat: 0.3, carbs: 0.45 },
};

/** A split in whole per cent, as a profile keeps it, as the shares of one the engine works with; null stays null. */
export function sharesOf(split: Macros | null | undefined): Macros | null {
  return split
    ? { protein: split.protein / 100, fat: split.fat / 100, carbs: split.carbs / 100 }
    : null;
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
  /** The custom diet's protein in grams per kilogram of the weight, where the profile sets its protein so (`ownSplit`). */
  customProteinPerKg?: number | null;
  weeklyLossTarget: '0.25' | '0.5' | '0.75' | '1.0' | null;
  manualCalorieTarget: number | null;
  /**
   * The correction of the formula's maintenance a profile accepted from its real expenditure, in kcal a
   * day (`Expenditure`); nothing where it accepted none.
   */
  expenditureCorrection?: number;
}

/** The most of maintenance a pace of loss may take away each day. */
const MAX_DEFICIT_SHARE = 0.25;

/**
 * The most a pace of loss may take away each day for each kilogram of the
 * body: 1 % of its weight a week (0.01 × 7700 kcal ÷ 7 days). For a light
 * body this is less than a quarter of maintenance; the guides for lean people
 * losing weight name 0.5 to 1 % of the weight a week as the pace that keeps
 * muscle.
 */
const MAX_DEFICIT_KCAL_PER_KG = 11;

/** From `OLDER_AGE` the fastest pace a profile is planned at (`OLDER_FASTEST_PACE_KG`). */
const OLDER_FASTEST_PACE = String(OLDER_FASTEST_PACE_KG) as CalorieEngineInput['weeklyLossTarget'];

/**
 * Basal Metabolic Rate via Mifflin-St Jeor.
 * Sex offset: +5 male, -161 female. For anybody else, and where it is not said,
 * we use the midpoint (-78) so the estimate is unbiased rather than defaulting
 * to one sex.
 */
export function calculateBmr(
  input: Pick<CalorieEngineInput, 'age' | 'sex' | 'heightCm' | 'weightKg'>,
): number {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  const sexOffset = input.sex === 'male' ? 5 : input.sex === 'female' ? -161 : -78;
  return round(base + sexOffset);
}

/**
 * Maintenance calories (TDEE) = BMR × activity multiplier. Under 18 the
 * multiplier is at least moderate activity's: the Polish norms of 2024 give
 * the young of 10 to 18 years a physical activity level of 1.6, 1.8 or 2.0,
 * none lower, since a growing body uses more than a sitting adult.
 */
export function calculateMaintenance(
  bmr: number,
  body: { activityLevel: ActivityLevel; age: number },
): number {
  const multiplier = ACTIVITY_MULTIPLIER[body.activityLevel];
  return round(
    bmr * (body.age < ADULT_AGE ? Math.max(multiplier, ACTIVITY_MULTIPLIER.moderate) : multiplier),
  );
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

/** `value` held between `least` and `most`. */
const within = (value: number, least: number, most: number): number =>
  Math.min(most, Math.max(least, value));

/** The energy of the protein of `perKg` grams for each of `weightKg` kilograms, in kcal. */
export const proteinKcalOf = (perKg: number, weightKg: number): number =>
  perKg * weightKg * KCAL_PER_GRAM.protein;

/**
 * The custom diet's split of a day of `calories`. Without protein of its own
 * (`proteinKcal` null) it is `split` as it is. With it, the way of protein per
 * kilogram, protein takes the energy of its grams, fat its share of `split`
 * and carbohydrate the rest; a share outside the limits every split keeps
 * (`SPLIT_SHARE_LIMITS`) is held at the limit, protein giving way where
 * carbohydrate would go past one of its own, and `held` says protein was
 * moved. Fat stays as it was set.
 */
export function ownSplit(
  split: Macros,
  proteinKcal: number | null,
  calories: number,
): { shares: Macros; held: boolean } {
  if (proteinKcal === null || calories <= 0) return { shares: split, held: false };
  const { least, most } = proteinShareBounds(split.fat);
  const asked = proteinKcal / calories;
  const kept = within(asked, least, most);
  return {
    shares: { protein: kept, fat: split.fat, carbs: 1 - kept - split.fat },
    held: Math.abs(kept - asked) > 1e-9,
  };
}

/**
 * Shares of one as whole per cent that add up to a hundred, each rounded the
 * way that misses its share least: the split a client that reads whole per
 * cent is shown.
 */
export function wholePercent(shares: Macros): Macros {
  const parts = (['protein', 'fat', 'carbs'] as const).map((part) => {
    const exact = shares[part] * 100;
    return { part, floor: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = 100 - parts.reduce((sum, one) => sum + one.floor, 0);
  for (const one of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    one.floor += 1;
    left -= 1;
  }
  return Object.fromEntries(parts.map((one) => [one.part, one.floor])) as unknown as Macros;
}

/** The share of their energy that protein, fat and carbohydrate each carry; null when they hold none. */
export function energyShares(grams: Macros): Macros | null {
  const protein = grams.protein * KCAL_PER_GRAM.protein;
  const fat = grams.fat * KCAL_PER_GRAM.fat;
  const carbs = grams.carbs * KCAL_PER_GRAM.carbs;
  const total = protein + fat + carbs;
  return total > 0 ? { protein: protein / total, fat: fat / total, carbs: carbs / total } : null;
}

/**
 * How far what a day holds may lie from the split it aims at, as the share of
 * its energy that would have to move, before it is said: more than a new plan
 * comes to on all but about one day in thirty.
 */
export const MACROS_OFF = 0.12;

/** How far one split is from another: the share of the energy that would have to move, from 0 to 1. */
export function splitDistance(a: Macros, b: Macros): number {
  return (
    (Math.abs(a.protein - b.protein) + Math.abs(a.fat - b.fat) + Math.abs(a.carbs - b.carbs)) / 2
  );
}

/**
 * The diets whose share of carbohydrate is a ceiling and not an aim, each with
 * the floor under which its day is held to that floor: a low-carbohydrate day
 * from a tenth of its energy up to its ceiling, under which the literature
 * calls it ketogenic, and a ketogenic one anywhere under its ceiling. Inside
 * that band a day is held to its protein, fat taking what is left.
 */
const CARB_FLOOR: Readonly<Partial<Record<string, number>>> = { low_carb: 0.1, keto: 0 };

/** The floor of a diet whose share of carbohydrate is a ceiling (`CARB_FLOOR`), null where the share is an aim. */
export const carbFloor = (dietType: string): number | null => CARB_FLOOR[dietType] ?? null;

/**
 * How far a day's shares stand from the split it aims at on its diet: as
 * `splitDistance` has it, except that on a diet whose carbohydrate is a
 * ceiling a day under it is measured against the split with its own share of
 * carbohydrate, or with the floor's where it is under the floor
 * (`CARB_FLOOR`), fat taking the rest. Inside the band that is as far off as
 * its protein is; the distances meet at the ceiling and at the floor, so a day
 * moving across either moves no step.
 */
export function distanceOnDiet(shares: Macros, aim: Macros, dietType: string): number {
  return splitDistance(shares, aimOnDiet(shares, aim, dietType));
}

/** The split a day's shares are measured against on its diet (`distanceOnDiet`): `aim`, or within a ceiling's band. */
export function aimOnDiet(shares: Macros, aim: Macros, dietType: string): Macros {
  const floor = carbFloor(dietType);
  if (floor === null || shares.carbs >= aim.carbs) return aim;
  const carbs = Math.max(shares.carbs, Math.min(floor, aim.carbs));
  return { protein: aim.protein, fat: 1 - aim.protein - carbs, carbs };
}

/**
 * `aim`, the grams a day of `calories` aims at, as a person reads it: on a
 * diet whose carbohydrate is a ceiling (`CARB_FLOOR`) with that floor in grams,
 * and fat as what protein and `carbs`, the day's carbohydrate kept inside the
 * band, leave of the energy; at the ceiling where the day's is not known.
 */
export function shownTarget(
  aim: Macros,
  calories: number,
  dietType: string,
  carbs?: number | null,
): TargetMacros {
  const floor = carbFloor(dietType);
  if (floor === null) return { ...aim, carbsFloor: null };
  const carbsFloor = round((calories * floor) / KCAL_PER_GRAM.carbs);
  const held = Math.min(aim.carbs, Math.max(carbsFloor, carbs ?? aim.carbs));
  const left = calories - aim.protein * KCAL_PER_GRAM.protein - held * KCAL_PER_GRAM.carbs;
  return {
    protein: aim.protein,
    fat: round(Math.max(0, left) / KCAL_PER_GRAM.fat),
    carbs: aim.carbs,
    carbsFloor,
  };
}

/** Split a calorie target into target macros (grams) for a diet type; `own` is the split of the custom diet. */
export function macrosForCalories(
  calories: number,
  dietType: DietType,
  own?: Macros | null,
): Macros {
  const split = macroSplitOf(dietType, own);
  return {
    protein: round((calories * split.protein) / KCAL_PER_GRAM.protein),
    fat: round((calories * split.fat) / KCAL_PER_GRAM.fat),
    carbs: round((calories * split.carbs) / KCAL_PER_GRAM.carbs),
  };
}

/** Energy and the three macronutrients of something eaten, in kcal and grams. */
type Figures = Macros & { calories: number };

/** What `figures` come to taken `factor` times: servings of a meal, or another amount of the same food. */
export function scaledFigures(figures: Figures, factor: number): Figures {
  return {
    calories: figures.calories * factor,
    protein: figures.protein * factor,
    fat: figures.fat * factor,
    carbs: figures.carbs * factor,
  };
}

/**
 * How much more energy the macronutrients somebody typed may carry than the
 * energy typed with them before the two are taken to contradict each other: a
 * label rounds its figures, and counts some carbohydrates at less than four
 * kilocalories a gram.
 */
const TYPED_ENERGY_SLACK = { share: 0.1, kcal: 5 };

/**
 * The macronutrients of something known by its energy and by some of them:
 * those left out share what is left of the energy, in the proportions `split`
 * (shares of one) gives them. Null where the ones given carry clearly more
 * energy than the whole, which cannot both be right.
 */
export function estimatedMacros(
  calories: number,
  known: Partial<Macros>,
  split: Macros,
): Macros | null {
  const knownKcal = kcalOfMacros(known);
  if (knownKcal > calories * (1 + TYPED_ENERGY_SLACK.share) + TYPED_ENERGY_SLACK.kcal) return null;
  return filledMacros(calories, known, split);
}

const MACRO_PARTS = ['protein', 'fat', 'carbs'] as const;

/** The energy in the macronutrients that are known. */
function kcalOfMacros(known: Partial<Macros>): number {
  return MACRO_PARTS.reduce((sum, part) => sum + (known[part] ?? 0) * KCAL_PER_GRAM[part], 0);
}

/**
 * The macronutrients of something known by its energy and by some of them:
 * those left out share what is left of the energy, in the proportions `split`
 * gives them, and get nothing where the ones given already carry all of it.
 */
export function filledMacros(calories: number, known: Partial<Macros>, split: Macros): Macros {
  const knownKcal = kcalOfMacros(known);
  const parts = MACRO_PARTS;
  const missing = parts.filter((part) => known[part] === undefined);
  const missingShare = missing.reduce((sum, part) => sum + split[part], 0);
  const left = Math.max(0, calories - knownKcal);
  const grams = (part: (typeof parts)[number]): number => {
    const given = known[part];
    if (given !== undefined) return given;
    // Shares that leave the missing ones nothing give them equal parts.
    const share = missingShare > 0 ? split[part] / missingShare : 1 / missing.length;
    return (left * share) / KCAL_PER_GRAM[part];
  };
  return { protein: grams('protein'), fat: grams('fat'), carbs: grams('carbs') };
}

/**
 * The calorie target of a profile, with everything a client needs to explain
 * it.
 *
 * A calculated target is maintenance less the deficit of the chosen pace.
 * The deficit is at most a quarter of maintenance and at most 1 % of the
 * body's weight a week; from 65 the pace is at most 0.5 kg a week. The target
 * is never under the floor, and never above maintenance: where maintenance
 * itself is under the floor, no loss is planned. A target somebody typed is
 * taken as it is, and flagged when it is under the floor or under the basal
 * rate.
 *
 * Somebody under 18 or underweight is planned no loss: a pace, or a typed
 * target under maintenance, is held at maintenance.
 *
 * A correction from the real expenditure never takes a target nobody typed
 * under what the body uses at rest, nor under the floor where the formula's
 * maintenance reaches it, nor a body under 18 or underweight under the
 * formula's maintenance: a diary written in part gives a figure too low.
 */
export function calculateCalories(input: CalorieEngineInput): CalorieCalculation {
  const bmr = calculateBmr(input);
  // The formula's maintenance, and that moved by what the diary and the weights showed the body really uses,
  // where the profile accepted that.
  const formula = calculateMaintenance(bmr, input);
  const maintenance = formula + (input.expenditureCorrection ?? 0);
  const requestedDeficit = deficitForWeeklyTarget(input.weeklyLossTarget);
  const floor = safetyFloor(input.sex);
  const manual = input.manualCalorieTarget;
  const source: CalorieCalculation['source'] = manual === null ? 'calculated' : 'manual_override';

  const atRisk = riskOfLosingWeight(input);
  // A body planned no loss is held at the more of its two maintenances: a deficit by neither.
  const kept = Math.max(maintenance, formula);
  const asksForLoss = manual === null ? requestedDeficit > 0 : manual < kept;
  const goalHeld = atRisk.length > 0 && asksForLoss;
  const older = input.age >= OLDER_AGE;
  const paceHeldForAge = older && requestedDeficit > deficitForWeeklyTarget(OLDER_FASTEST_PACE);

  let dailyTarget: number;
  let deficitCapped = false;
  let safetyFloorApplied = false;
  let maintenanceUnderFloor = false;
  if (goalHeld) {
    dailyTarget = kept;
  } else if (manual !== null) {
    dailyTarget = manual;
  } else {
    const allowed = paceHeldForAge ? deficitForWeeklyTarget(OLDER_FASTEST_PACE) : requestedDeficit;
    const most = Math.min(
      round(maintenance * MAX_DEFICIT_SHARE),
      round(input.weightKg * MAX_DEFICIT_KCAL_PER_KG),
    );
    deficitCapped = allowed > most;
    const paced = maintenance - Math.min(allowed, most);
    maintenanceUnderFloor = maintenance < floor;
    safetyFloorApplied = !maintenanceUnderFloor && paced < floor;
    dailyTarget = maintenanceUnderFloor ? maintenance : Math.max(paced, floor);
  }
  // What the body uses at rest, or the floor where the formula's maintenance reaches it, and for a body planned no
  // loss the formula's maintenance: no correction from the real expenditure takes a target nobody typed under that.
  const restingBound = Math.max(bmr, atRisk.length > 0 ? formula : Math.min(floor, formula));
  const correctionHeld = manual === null && dailyTarget < restingBound;
  if (correctionHeld) dailyTarget = restingBound;
  dailyTarget = round(dailyTarget);
  // The custom diet's split of this target: with protein of its own grams where the profile sets it per kilogram.
  const own =
    input.dietType === 'custom' && input.customMacroSplit
      ? ownSplit(
          input.customMacroSplit,
          input.customProteinPerKg != null
            ? proteinKcalOf(input.customProteinPerKg, input.weightKg)
            : null,
          dailyTarget,
        )
      : null;
  const bmi = input.weightKg / (input.heightCm / 100) ** 2;

  return {
    bmr,
    maintenance,
    weeklyLossTarget: input.weeklyLossTarget,
    requestedDeficit,
    dailyDeficit: maintenance - dailyTarget,
    weeklyLossKg: Math.max(
      0,
      Math.round(((maintenance - dailyTarget) * 7 * 100) / KCAL_PER_KG_FAT) / 100,
    ),
    dailyTarget,
    targetMacros: shownTarget(
      macrosForCalories(dailyTarget, input.dietType, own?.shares ?? null),
      dailyTarget,
      input.dietType,
    ),
    customSplitHeld: own?.held ?? false,
    source,
    safetyFloor: floor,
    deficitCapped,
    paceHeldForAge: paceHeldForAge && !goalHeld && manual === null,
    safetyFloorApplied,
    maintenanceUnderFloor,
    goalHeld,
    correctionHeld,
    leastTypedTarget: leastTypedTarget(formula),
    warnings: [
      ...atRisk,
      ...(older && bmi < OLDER_LOSS_BMI ? (['older'] as const) : []),
      ...(source === 'manual_override' && dailyTarget < floor ? (['below_floor'] as const) : []),
      ...(dailyTarget < bmr ? (['below_bmr'] as const) : []),
    ],
  };
}

/**
 * The least a target this body types may be: `MIN_CALORIE_TARGET`, or the
 * formula's maintenance where that is lower, so that a small body may type
 * its own maintenance; never under `LOWEST_CALORIE_TARGET`.
 */
function leastTypedTarget(formulaMaintenance: number): number {
  return Math.max(LOWEST_CALORIE_TARGET, Math.min(MIN_CALORIE_TARGET, round(formulaMaintenance)));
}

/** Round to whole numbers — calorie/macro outputs are always integers. */
function round(n: number): number {
  return Math.round(n);
}

/** The kind of day a plan day is: it shapes the day's target. */
export type DayType = 'normal' | 'rest' | 'training';

/**
 * What a day of each kind takes against a usual day of its week: a training
 * day about 15 % more, a rest day about 15 % less. The kinds move calories
 * between the days of a week (`weekScale`), they add none: the activity level
 * a profile names already holds the training of an average week.
 */
export const DAY_KIND_FACTOR: Readonly<Record<DayType, number>> = {
  normal: 1,
  training: 1.15,
  rest: 0.85,
};

/** A day of a week of a plan, as far as the week's sharing of its base goes. */
export interface WeekDay {
  dayType?: DayType;
  /** A target somebody set for the day: taken as it is, and out of the week's sharing. */
  ownTarget?: number | null;
  /** A skipped day plans nothing, and is out of the week's sharing. */
  skip?: boolean;
}

/** The day takes part in its week's sharing of the base: it is not skipped, and has no target of its own. */
export const sharesTheWeek = (day: WeekDay): boolean =>
  day.skip !== true && (day.ownTarget ?? null) === null;

/**
 * What a usual day of a week of a plan is, against the plan's base: the
 * factor that leaves the average of the days that share the week on the base,
 * whatever kinds they are. Three training days and four usual ones: 7 / 7.45,
 * so a usual day 2010 kcal and a training day 2310 kcal of a base of 2135.
 */
export function weekScale(days: readonly WeekDay[]): number {
  const sharing = days.filter(sharesTheWeek);
  if (sharing.length === 0) return 1;
  const kinds = sharing.reduce((sum, day) => sum + DAY_KIND_FACTOR[day.dayType ?? 'normal'], 0);
  return sharing.length / kinds;
}

/** The weeks of a plan are its days in sevens from its first: the week a day is in. */
export const weekOfDay = (dayIndex: number): number => Math.floor(dayIndex / 7);

/** For each day of a plan, the scale of its week (`weekScale`). */
export function weekScales(days: readonly WeekDay[]): number[] {
  const scales = new Map<number, number>();
  return days.map((_, index) => {
    const week = weekOfDay(index);
    if (!scales.has(week)) scales.set(week, weekScale(days.slice(week * 7, week * 7 + 7)));
    return scales.get(week)!;
  });
}

/**
 * The calorie target of one day of a plan. The one place where it is decided.
 *
 *  - A target the user set for that day is taken as it is, unless the
 *    profile's loss goal is held and the target is under maintenance.
 *  - Otherwise the plan's base, times the scale of the day's week
 *    (`weekScale`), is shaped by the kind of day and rounded to ten. When the
 *    base was calculated, a rest day does not take it under the floor (nor
 *    under the base itself, where that is under the floor already). When
 *    somebody typed the base, the day follows it down, but never under the
 *    least a typed target may be.
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
  /** What a usual day of the day's week is against the base (`weekScale`); one where left out. */
  scale?: number;
  /** The target the user set for this day. */
  ownTarget?: number | null;
  /** Maintenance, for a profile whose loss goal is held: a day's own target under it is not taken. */
  holdUnder?: number | null;
}): { target: number; belowFloor: boolean } {
  const own = day.ownTarget ?? null;
  const held = own !== null && day.holdUnder != null && own < day.holdUnder;
  if (own !== null && !held) return { target: own, belowFloor: own < day.floor };
  const factor = DAY_KIND_FACTOR[day.dayType ?? 'normal'] * (day.scale ?? 1);
  // To a thousandth of a kilocalorie first: a product of factors lands a hair off a half, which rounds up.
  const exact = Math.round(day.base * factor * 1000) / 1000;
  const shaped = Math.round(exact / 10) * 10;
  const least = day.baseIsCalculated ? Math.min(day.floor, day.base) : LOWEST_CALORIE_TARGET;
  const target = Math.max(shaped, least);
  return { target, belowFloor: !day.baseIsCalculated && target < day.floor };
}

/**
 * What a day of a plan aims at of protein, fat and carbohydrate, in grams.
 * Every day keeps the protein of a day at the plan's own target (`base`,
 * rounded to ten as a day's target is): the kinds of day move carbohydrate and
 * fat between the days of a week, and protein stays put, so that a usual day
 * of a week without other kinds is its target split as the diet splits a day.
 * The carbohydrates keep their share of the day's energy, so a diet that holds
 * them under a share of it (keto, low-carb) holds them there on every day, and
 * fat takes what is left. A day with a target of its own splits it as the diet
 * splits a day.
 */
export function dayMacros(
  day: { target: number; base: number; ownTarget?: number | null },
  dietType: DietType,
  own?: Macros | null,
): Macros {
  if ((day.ownTarget ?? null) !== null) return macrosForCalories(day.target, dietType, own);
  const split = macroSplitOf(dietType, own);
  const usual = Math.round(day.base / 10) * 10;
  const protein = (usual * split.protein) / KCAL_PER_GRAM.protein;
  const carbs = (day.target * split.carbs) / KCAL_PER_GRAM.carbs;
  // What is left, of the figures before they are rounded: on a usual day, the diet's own share of fat.
  const left = day.target - protein * KCAL_PER_GRAM.protein - carbs * KCAL_PER_GRAM.carbs;
  return {
    protein: round(protein),
    fat: round(Math.max(0, left) / KCAL_PER_GRAM.fat),
    carbs: round(carbs),
  };
}
