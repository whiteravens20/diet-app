// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Packs: what one buys of an ingredient at a time, and what a plan leaves of
 * the last one it opens.
 *
 * The rule the planner goes by is the cook's, not the factory's: a pack that
 * is used to about seven tenths is used. What is left of it is no reason to
 * plan another meal, and a meal that would need a little more than the pack
 * holds is a reason against that meal: it opens a second pack for the sake of
 * a spoonful. A pack that is opened and mostly left is what a plan does well
 * to come back to.
 *
 * Only an ingredient whose opened pack does not keep counts in what a plan
 * leaves. Rice from a kilogram bag is not wasted by a plan that takes a cup
 * of it.
 */

/** The share of a pack that may be left without that counting as waste. */
export const ACCEPTED_LEFT = 0.3;

/**
 * A need that runs over whole packs by no more than this share of one takes
 * the whole packs: nobody opens another for 8 g of salmon.
 */
export const SPOONFUL = 0.05;

/** With this many days of a plan still to come, a pack that a meal opens is held against no meal: there is a week to use it in. */
export const DAYS_TO_USE_A_PACK = 7;

const clean = (n: number): number => Math.round(n * 1e6) / 1e6;

/** How many packs a need takes: none for no need, and never none for a need there is. */
export function packsFor(need: number, packSize: number): number {
  if (need <= 0 || packSize <= 0) return 0;
  const packs = clean(need / packSize);
  const whole = Math.floor(packs);
  return whole >= 1 && clean(packs - whole) <= SPOONFUL ? whole : Math.ceil(packs);
}

/** What is left of the last pack when a need is taken out of whole packs: nothing where the need takes them all and a spoonful more. */
export function leftOf(need: number, packSize: number): number {
  return need <= 0 || packSize <= 0 ? 0 : Math.max(0, clean(packsFor(need, packSize) * packSize - need));
}

/**
 * How much more of the last pack is left than is accepted, as a share of a
 * pack: nothing while the pack is used to seven tenths or more, and nothing
 * where no pack was opened.
 */
export function leftBeyondAccepted(need: number, packSize: number): number {
  if (need <= 0 || packSize <= 0) return 0;
  return Math.max(0, clean(leftOf(need, packSize) / packSize - ACCEPTED_LEFT));
}

/**
 * What a meal does to the packs of a plan, from -1 to 1. Above nothing: it
 * takes from a pack that was mostly left. Under nothing: it opens a pack that
 * will be mostly left, a first one or another after one that was used well.
 * Nothing: it leaves the packs as well used as they were, as a meal does that
 * takes the last of a pack used to seven tenths.
 *
 * A pack that is opened early has the rest of the plan to be used in, so how
 * much opening one is held against a meal goes by `daysToCome`, the days of
 * the plan that are still to be filled after the meal's own: nothing with a
 * week of them, all of it with none.
 *
 * `before` is what the plan holds of each ingredient so far, `meal` what the
 * meal would add, `packs` the pack of each ingredient whose opened pack does
 * not keep. All in the ingredient's own unit.
 */
export function packPull(
  meal: ReadonlyMap<string, number>,
  before: (ingredientId: string) => number,
  packs: ReadonlyMap<string, number>,
  daysToCome = 0,
): number {
  const heldAgainst = 1 - Math.min(1, Math.max(0, daysToCome) / DAYS_TO_USE_A_PACK);
  let pull = 0;
  for (const [ingredientId, amount] of meal) {
    const packSize = packs.get(ingredientId);
    if (packSize === undefined || amount <= 0) continue;
    const held = Math.max(0, before(ingredientId));
    const change = leftBeyondAccepted(held, packSize) - leftBeyondAccepted(held + amount, packSize);
    pull += change >= 0 ? change : change * heldAgainst;
  }
  // The most one pack can move is what is beyond the accepted share of it.
  return Math.max(-1, Math.min(1, clean(pull / (1 - ACCEPTED_LEFT))));
}

/** A pack a plan opens and does not finish. */
export interface OpenPack {
  ingredientId: string;
  packSize: number;
  /** How many packs the plan takes of the ingredient. */
  packs: number;
  /** What the plan uses of it, and what it leaves of the last pack. */
  used: number;
  left: number;
  /** More is left than the accepted share of a pack. */
  wasted: boolean;
}

/** What a plan buys in packs that do not keep, against what it uses of them. */
export interface PackUse {
  bought: number;
  used: number;
  /** The packs that are not finished, the one with the most left first. */
  open: OpenPack[];
}

/**
 * What a plan comes to in packs: for every ingredient whose opened pack does
 * not keep, the whole packs its need takes and what is left of the last.
 * Grams and millilitres are added up as they are: the sum says how much of
 * what is bought is used, not what it weighs.
 */
export function packUse(needs: ReadonlyMap<string, number>, packs: ReadonlyMap<string, number>): PackUse {
  const open: OpenPack[] = [];
  let bought = 0;
  let used = 0;
  for (const [ingredientId, need] of needs) {
    const packSize = packs.get(ingredientId);
    if (packSize === undefined || packSize <= 0 || need <= 0) continue;
    const count = packsFor(need, packSize);
    const left = leftOf(need, packSize);
    bought += count * packSize;
    // A need that is a spoonful over its packs uses all of them, and no more than they hold.
    used += Math.min(need, count * packSize);
    if (left > 0) open.push({ ingredientId, packSize, packs: count, used: clean(need), left, wasted: leftBeyondAccepted(need, packSize) > 0 });
  }
  open.sort((a, b) => b.left / b.packSize - a.left / a.packSize || (a.ingredientId < b.ingredientId ? -1 : 1));
  return { bought: clean(bought), used: clean(used), open };
}
