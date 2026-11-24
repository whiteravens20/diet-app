// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How a day's carbohydrate reads against what it aims at: on low-carb as the
 * diet's band (`range`, from its floor up to its ceiling), on keto as a ceiling
 * alone (`ceiling`, its floor being none), elsewhere against its target
 * (`none`). The messages that say a day's macronutrients take it as `band`,
 * with `carbsFloor` beside it.
 */
export type CarbsBand = 'range' | 'ceiling' | 'none';

export function carbsBandOf(target: { carbsFloor: number | null }): CarbsBand {
  if (target.carbsFloor === null) return 'none';
  return target.carbsFloor > 0 ? 'range' : 'ceiling';
}

/** The values a message that says a day's carbohydrate against its target takes for its band. */
export function bandValues(target: { carbsFloor: number | null }): {
  band: CarbsBand;
  carbsFloor: number;
} {
  return { band: carbsBandOf(target), carbsFloor: target.carbsFloor ?? 0 };
}

/**
 * Where an amount of carbohydrate stands against the band of its diet, in the whole grams it is shown in:
 * over its ceiling, under its floor, or in it. Said beside the band, which is no verdict by itself.
 */
export type CarbsStanding = 'over' | 'under' | 'in';

export function carbsStandingOf(
  carbs: number,
  target: { carbs: number; carbsFloor: number | null },
): CarbsStanding {
  const grams = Math.round(carbs);
  if (target.carbsFloor === null) return 'in';
  if (grams > Math.round(target.carbs)) return 'over';
  if (grams < Math.round(target.carbsFloor)) return 'under';
  return 'in';
}
