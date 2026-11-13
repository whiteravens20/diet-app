// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The two levels of a plan that wastes less of what it buys, side by side:
 * "Mniej marnowania" (`GeneratePlanRequest.lessWaste`) and "Bez marnowania"
 * (`GeneratePlanRequest.noWaste`), each with what the planner weighs, how far
 * closing its packs may take a day from its split, what rests of packs its
 * meals may take, within how many days an opened pack is to be eaten, and the
 * limits on repeats it puts in the place of the profile's.
 */
import { SPLIT_SLACK } from './close-packs.js';
import { LESS_WASTE_WEIGHTS, NO_WASTE_WEIGHTS, type ScoreWeights } from './optimizer.js';
import { LESS_WASTE_RESTS, NO_WASTE_RESTS, type RestCaps } from './pack-rests.js';
import { keepDaysOf } from './packs.js';

export interface WasteLevel {
  weights: ScoreWeights;
  /** How much further from its split than the planner left it closing the packs may take a day. */
  splitSlack: number;
  rests: RestCaps;
  /** The days an opened pack of an ingredient is to be eaten within. */
  keepDays: (ingredient: { keepDays?: number | null; category?: string | null }) => number;
  /** The repeats it allows whatever the profile says: the most days running and times in seven days of one dish, and whether twice a day. */
  repeats?: { daysInARow: number; timesAWeek: number; twiceADay: boolean };
}

/** "Mniej marnowania": the planner leans on the pantry and the packs, within the profile's limits. */
export const LESS_WASTE: WasteLevel = {
  weights: LESS_WASTE_WEIGHTS,
  splitSlack: SPLIT_SLACK,
  rests: LESS_WASTE_RESTS,
  keepDays: keepDaysOf,
};

/** The days a pack of meat or fish, and any other, is eaten within in a plan that wastes nothing, at most. */
export const NO_WASTE_DAYS = { meatAndFish: 3, other: 5 } as const;

/**
 * "Bez marnowania": every pack used within days (meat and fish within 3 at
 * most, anything else within 5), the same dish up to 3 days running, 5 times
 * in seven days and twice a day, whatever the profile says, and a day a little
 * further from its split. The profile's limits on kinds of protein, its
 * allergens, what it avoids and its diet hold as ever.
 */
export const NO_WASTE: WasteLevel = {
  weights: NO_WASTE_WEIGHTS,
  splitSlack: 0.03,
  rests: NO_WASTE_RESTS,
  keepDays: (ingredient) =>
    Math.min(
      keepDaysOf(ingredient),
      ingredient.category === 'meat' || ingredient.category === 'fish'
        ? NO_WASTE_DAYS.meatAndFish
        : NO_WASTE_DAYS.other,
    ),
  repeats: { daysInARow: 3, timesAWeek: 5, twiceADay: true },
};
