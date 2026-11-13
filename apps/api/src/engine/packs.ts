// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Packs: what one buys of an ingredient at a time, how long an opened one
 * keeps, and what a plan throws away of the ones it opens.
 *
 * The count is a kitchen's, day by day. A need is taken from the pack that is
 * open while it keeps; past its last day what is left in it is thrown away,
 * and a need after that opens another. What is in the last pack when the plan
 * ends is left too: a first plan has nothing after it to eat it.
 *
 * The rule the planner goes by is the cook's, not the factory's: a pack that
 * is used to about four fifths is used. What is left of it is no reason to
 * plan another meal, and a meal that would need a little more than the pack
 * holds is a reason against that meal: it opens a second pack for the sake of
 * a spoonful. A pack that is opened and mostly left is what a plan does well
 * to come back to while it keeps.
 *
 * Only an ingredient whose opened pack does not keep counts. Rice from a
 * kilogram bag is not wasted by a plan that takes a cup of it.
 */

/** The share of a pack that may be left without that counting as waste. */
export const ACCEPTED_LEFT = 0.2;

/**
 * A need that runs over whole packs by no more than this share of one takes
 * the whole packs: nobody opens another for 8 g of salmon.
 */
export const SPOONFUL = 0.05;

/** With this many days of a plan still to come in which a pack keeps, opening one is held against no meal: there is a week to use it in. */
export const DAYS_TO_USE_A_PACK = 7;

/** Below this an amount is the noise of converting units, not food. */
const CRUMB = 1e-6;

const clean = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A pack of an ingredient whose opened pack does not keep. */
export interface Pack {
  /** What one buys of it at a time, in the ingredient's own unit. */
  size: number;
  /** The days an opened one is eaten from, the day it is opened among them. */
  keepDays: number;
}

/**
 * The days an opened pack keeps: the ingredient's own, or where the database
 * has not been brought up to the data that gives them, two for meat and fish
 * and three for anything else.
 */
export function keepDaysOf(ingredient: {
  keepDays?: number | null;
  category?: string | null;
}): number {
  if (ingredient.keepDays != null && ingredient.keepDays >= 1) return ingredient.keepDays;
  return ingredient.category === 'meat' || ingredient.category === 'fish' ? 2 : 3;
}

/** How many packs a need takes: none for no need, and never none for a need there is. */
export function packsFor(need: number, packSize: number): number {
  if (need <= 0 || packSize <= 0) return 0;
  const packs = clean(need / packSize);
  const whole = Math.floor(packs);
  return whole >= 1 && clean(packs - whole) <= SPOONFUL ? whole : Math.ceil(packs);
}

/** What is beyond the accepted fifth of a pack in what is left of it, as a share of the pack. */
const beyondAccepted = (left: number, packSize: number): number =>
  packSize > 0 ? Math.max(0, clean(left / packSize - ACCEPTED_LEFT)) : 0;

/** An opened pack of an ingredient: what is left in it, and the last day it is eaten from. */
export interface Opened {
  left: number;
  until: number;
}

/** What a day's need of an ingredient does to its packs. */
export interface PackStep {
  /** The pack that is open after it, if anything is left in one. */
  opened: Opened | undefined;
  /** What the need buys, and what it eats of that and of the pack that was open. */
  bought: number;
  used: number;
  /** What was left in a pack that no longer keeps on the need's day, thrown away: the amount and its last day. */
  thrown: Opened | undefined;
}

/**
 * A day's need of an ingredient: taken from the pack that is open while it
 * keeps, the rest from whole new packs, of which the last is then the open
 * one. A spoonful more than the open pack holds takes no new one.
 */
export function packStep(
  opened: Opened | undefined,
  need: number,
  pack: Pack,
  day: number,
): PackStep {
  let thrown: Opened | undefined;
  let left = 0;
  let until = -1;
  if (opened !== undefined) {
    if (opened.until >= day) {
      left = opened.left;
      until = opened.until;
    } else if (opened.left > CRUMB) thrown = opened;
  }
  const fromOpen = Math.min(left, Math.max(0, need));
  left -= fromOpen;
  const rest = Math.max(0, need) - fromOpen;
  let bought = 0;
  let used = fromOpen;
  if (rest > CRUMB) {
    if (fromOpen > 0 && rest <= SPOONFUL * pack.size) {
      // The open pack does for a spoonful more: it is finished.
      left = 0;
    } else {
      const count = packsFor(rest, pack.size);
      bought = count * pack.size;
      used += Math.min(rest, bought);
      left = Math.max(0, bought - rest);
      until = day + pack.keepDays - 1;
    }
  }
  return {
    opened: left > CRUMB ? { left: clean(left), until } : undefined,
    bought: clean(bought),
    used: clean(used),
    thrown,
  };
}

/**
 * What a meal does to the packs of a plan, from -1 to 1. Above nothing: it
 * takes from an open pack that would be mostly left. Under nothing: it opens a
 * pack that will be mostly left, a first one, one after a pack that no longer
 * keeps, or another after one that was used well. Nothing: it leaves the packs
 * as well used as they were, as a meal does that takes the last of a pack used
 * to four fifths.
 *
 * A pack that is opened can be eaten from on the days it keeps, as far as the
 * plan goes, so how much opening one is held against a meal goes by those
 * days: nothing with a week of them still to be filled, all of it with none.
 * `daysAfter` is the days of the plan still to be filled after the meal's own.
 *
 * `opened` is what is open of each ingredient when the meal is eaten, `meal`
 * what one serving of it takes, `packs` the pack of each ingredient whose
 * opened pack does not keep. All in the ingredient's own unit. `servings` is
 * how many servings the meal is.
 */
export function packPull(
  meal: ReadonlyMap<string, number>,
  opened: (ingredientId: string) => Opened | undefined,
  packs: ReadonlyMap<string, Pack>,
  day: number,
  daysAfter = 0,
  servings = 1,
): number {
  let pull = 0;
  for (const [ingredientId, ofOne] of meal) {
    const pack = packs.get(ingredientId);
    const amount = ofOne * servings;
    if (pack === undefined || amount <= 0) continue;
    const before = opened(ingredientId);
    const inPack = before !== undefined && before.until >= day ? before.left : 0;
    const after = packStep(before, amount, pack, day);
    const change =
      beyondAccepted(inPack, pack.size) - beyondAccepted(after.opened?.left ?? 0, pack.size);
    if (change >= 0) {
      pull += change;
      continue;
    }
    const window = Math.min(Math.max(0, daysAfter), pack.keepDays - 1);
    pull += change * (1 - Math.min(1, window / DAYS_TO_USE_A_PACK));
  }
  // The most one pack can move is what is beyond the accepted share of it.
  return Math.max(-1, Math.min(1, clean(pull / (1 - ACCEPTED_LEFT))));
}

/** What a menu takes of each ingredient on each of its days, in the ingredient's own unit: `needs.get(ingredientId)[day]`. */
export type DailyNeeds = ReadonlyMap<string, readonly number[]>;

/** A pack a plan opens and does not finish. */
interface OpenPack {
  ingredientId: string;
  packSize: number;
  /** How many packs the plan takes of the ingredient. */
  packs: number;
  /** What the plan eats of the ingredient, and what is left in this pack. */
  used: number;
  left: number;
  /** More is left than the accepted share of a pack. */
  wasted: boolean;
  /** The last day it is eaten from: what is left in it is thrown away after it. */
  until: number;
  /** It still keeps when the plan ends: what is left is not thrown away yet. */
  atEnd: boolean;
}

/** What a plan buys in packs that do not keep, against what it eats of them. */
export interface PackUse {
  bought: number;
  used: number;
  /** The packs that are not finished, the one with the most left first. */
  open: OpenPack[];
}

/** What one ingredient's packs come to over a menu's days: what it buys and eats, and every pack it leaves something in. */
function walkPacks(
  byDay: readonly number[],
  pack: Pack,
): { bought: number; used: number; left: { opened: Opened; atEnd: boolean }[] } {
  let opened: Opened | undefined;
  let bought = 0;
  let used = 0;
  const left: { opened: Opened; atEnd: boolean }[] = [];
  byDay.forEach((need, day) => {
    if (need <= CRUMB) return;
    const step = packStep(opened, need, pack, day);
    if (step.thrown) left.push({ opened: step.thrown, atEnd: false });
    opened = step.opened;
    bought += step.bought;
    used += step.used;
  });
  if (opened !== undefined) left.push({ opened, atEnd: opened.until >= byDay.length - 1 });
  return { bought, used, left };
}

/**
 * The last day each pack of an ingredient a menu buys is eaten from, in the
 * order the packs are opened (`packStep`): a pack bought and finished on its
 * day ends that day, and the one left open ends on the last day that takes
 * from it while it keeps.
 */
export function packLastDays(byDay: readonly number[], pack: Pack): number[] {
  const last: number[] = [];
  let opened: Opened | undefined;
  let open = -1;
  byDay.forEach((need, day) => {
    if (need <= CRUMB) return;
    const fromOpen = opened !== undefined && opened.until >= day && opened.left > CRUMB;
    const step = packStep(opened, need, pack, day);
    if (fromOpen) last[open] = day;
    const count = pack.size > 0 ? Math.round(step.bought / pack.size) : 0;
    for (let i = 0; i < count; i += 1) last.push(day);
    if (count > 0) open = last.length - 1;
    opened = step.opened;
  });
  return last;
}

/**
 * The packs of a food that keeps from its purchase no longer than from its
 * opening (fresh meat and fish) a list's days take, the list's first day being
 * day 0: how many, as the plan counts them (a pack that no longer keeps on the
 * day of a need is not eaten from), and those of them not to be bought on the
 * first day, by the day from which they are: a pack eaten from last on day u is
 * bought on day u - keepDays + 1 at the earliest. What is at home (`held`) is
 * eaten first, from the first day on.
 */
export function freshPurchases(
  byDay: readonly number[],
  pack: Pack,
  held = 0,
): { count: number; later: { day: number; packs: number }[] } {
  let atHome = held;
  const toBuy = byDay.map((need) => {
    const taken = Math.min(atHome, Math.max(0, need));
    atHome -= taken;
    return need - taken;
  });
  const lastDays = packLastDays(toBuy, pack);
  const byFirstDay = new Map<number, number>();
  for (const last of lastDays) {
    const day = last - pack.keepDays + 1;
    if (day > 0) byFirstDay.set(day, (byFirstDay.get(day) ?? 0) + 1);
  }
  return {
    count: lastDays.length,
    later: [...byFirstDay].sort(([a], [b]) => a - b).map(([day, packs]) => ({ day, packs })),
  };
}

/**
 * What a plan comes to in packs, a kitchen's count: for every ingredient
 * whose opened pack does not keep, day by day, the packs it buys, what it eats
 * of them, and every pack it does not finish before it no longer keeps or the
 * plan ends. Grams and millilitres are added up as they are: the sum says how
 * much of what is bought is eaten, not what it weighs.
 */
export function packUse(needs: DailyNeeds, packs: ReadonlyMap<string, Pack>): PackUse {
  const open: OpenPack[] = [];
  let bought = 0;
  let used = 0;
  for (const [ingredientId, byDay] of needs) {
    const pack = packs.get(ingredientId);
    if (pack === undefined || pack.size <= 0) continue;
    const own = walkPacks(byDay, pack);
    if (own.bought <= 0) continue;
    bought += own.bought;
    used += own.used;
    for (const { opened, atEnd } of own.left)
      open.push({
        ingredientId,
        packSize: pack.size,
        packs: Math.round(own.bought / pack.size),
        used: clean(own.used),
        left: opened.left,
        wasted: beyondAccepted(opened.left, pack.size) > 0,
        until: opened.until,
        atEnd,
      });
  }
  open.sort(
    (a, b) =>
      b.left / b.packSize - a.left / a.packSize ||
      (a.ingredientId < b.ingredientId ? -1 : a.ingredientId > b.ingredientId ? 1 : 0) ||
      a.until - b.until,
  );
  return { bought: clean(bought), used: clean(used), open };
}

/** The packs one ingredient's needs leave something in: what is left in each, and the last day it is eaten from. */
export function packsLeftOver(byDay: readonly number[], pack: Pack): Opened[] {
  return pack.size > 0 ? walkPacks(byDay, pack).left.map(({ opened }) => opened) : [];
}

/** What a plan throws away of its packs, in packs: every pack it leaves something in, by how much of it is left. */
export function packsLeft(use: PackUse): number {
  return clean(use.open.reduce((sum, pack) => sum + pack.left / pack.packSize, 0));
}

/** What a plan leaves of its packs beyond the accepted fifth of each, in packs. */
export function packsLeftBeyondAccepted(use: PackUse): number {
  return clean(use.open.reduce((sum, pack) => sum + beyondAccepted(pack.left, pack.packSize), 0));
}
