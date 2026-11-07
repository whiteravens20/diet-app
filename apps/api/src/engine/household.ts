// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How one amount of a household list's row is shared out among the lists of
 * its plans, each of which settles with the pantry of its own profile: what
 * the household has at home, and what it holds for the row once it shopped.
 */

/** A row of one plan's list, as a row of the household list shares among them. */
export interface RowShare {
  /** What the plan needs. */
  need: number;
  /** What the plan's list counts as at home. */
  atHome: number;
}

const clean = (n: number): number => Math.round(n * 1e6) / 1e6;
const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * `total` in parts weighed by `weights`, none above its cap (`caps`, none when
 * left out): what a full part cannot take goes to the others by their weights,
 * and by the room they have once no part with a weight has any. A whole
 * `total` comes out in whole parts, the largest remainders taking what
 * rounding down leaves; the parts always add up to `total`, or to what the
 * caps hold together when that is less.
 */
export function shareOut(
  total: number,
  weights: readonly number[],
  caps?: readonly number[],
): number[] {
  const given = weights.map(() => 0);
  const room = (i: number): number => (caps ? Math.max(0, caps[i]! - given[i]!) : Infinity);
  let left = Math.max(0, caps ? Math.min(total, sum(caps)) : total);
  let open = weights.map((_, i) => i).filter((i) => room(i) > 0);
  while (left > 1e-9 && open.length > 0) {
    let weighed = open.map((i) => Math.max(0, weights[i]!));
    if (sum(weighed) <= 0) weighed = open.map((i) => (caps ? room(i) : 1));
    const whole = sum(weighed);
    const wanted = open.map((_, k) => (left * weighed[k]!) / whole);
    const full = open.filter((i, k) => wanted[k]! >= room(i));
    if (full.length === 0) {
      open.forEach((i, k) => (given[i]! += wanted[k]!));
      break;
    }
    // The parts that fill up take their room, and what is left is weighed again among the rest.
    for (const i of full) {
      left -= room(i);
      given[i] = caps![i]!;
    }
    open = open.filter((i) => !full.includes(i));
  }
  return inWholes(given, caps) ?? exactly(given);
}

/** The parts in whole numbers that add up to the same whole, the largest remainders first, none above its cap; null when they cannot. */
function inWholes(parts: readonly number[], caps?: readonly number[]): number[] | null {
  const goal = clean(sum(parts));
  if (!Number.isInteger(goal)) return null;
  const wholes = parts.map((part) => Math.floor(part + 1e-9));
  let units = Math.round(goal - sum(wholes));
  const order = parts
    .map((part, i) => ({ i, rest: part - wholes[i]! }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (units === 0) break;
    if (caps && wholes[i]! + 1 > caps[i]! + 1e-9) continue;
    wholes[i]! += 1;
    units -= 1;
  }
  return units === 0 ? wholes : null;
}

/** The parts as they are, free of floating-point noise, the largest taking what the noise leaves. */
function exactly(parts: readonly number[]): number[] {
  const goal = clean(sum(parts));
  const exact = parts.map(clean);
  const largest = exact.reduce((best, part, i) => (part > exact[best]! ? i : best), 0);
  exact[largest] = clean(exact[largest]! + goal - sum(exact));
  return exact;
}

/**
 * What each plan's list counts as at home when the household says it has
 * `atHome` for the row: shared as the profiles' pantries had it, by need when
 * none had any, and never more than a plan needs.
 */
export function shareAtHome(atHome: number, rows: readonly RowShare[]): number[] {
  const had = sum(rows.map((row) => row.atHome));
  return shareOut(
    atHome,
    rows.map((row) => (had > 0 ? row.atHome : row.need)),
    rows.map((row) => row.need),
  );
}

/**
 * What each plan's list holds when the household holds `purchased` for the
 * row, what is at home included: first what each has at home, then what each
 * lacks, and the rest by need, so that what a pack holds beyond the needs goes
 * into the pantries in proportion to what their plans need. Less than the
 * household has at home is shared as what is at home is.
 */
export function sharePurchase(purchased: number, rows: readonly RowShare[]): number[] {
  const atHome = rows.map((row) => row.atHome);
  if (purchased <= sum(atHome)) return shareOut(purchased, atHome);
  const lacks = rows.map((row) => Math.max(0, clean(row.need - row.atHome)));
  const bought = clean(purchased - sum(atHome));
  if (bought <= sum(lacks)) {
    const filled = shareOut(bought, lacks, lacks);
    return rows.map((row, i) => clean(row.atHome + filled[i]!));
  }
  const over = shareOut(
    clean(bought - sum(lacks)),
    rows.map((row) => row.need),
  );
  return rows.map((row, i) => clean(row.atHome + lacks[i]! + over[i]!));
}
