// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The pantry of one ingredient, and the one way anything but its owner's own
 * hand changes it.
 *
 * A profile holds an ingredient in at most one row per unit: six eggs as
 * pieces next to 200 g of egg white as grams. What counts as "how much is
 * there" is the sum of those rows in the ingredient's canonical unit. A row
 * in a unit the ingredient cannot be converted from (pieces of something that
 * has no weight per piece) counts as nothing and is never touched.
 *
 * A shopping-list row changes the pantry when it is ticked off: what the list
 * took as "already at home" leaves the pantry, what was bought beyond the need
 * enters it. `settle` moves a row's net effect on the pantry to a new target,
 * and returns the moves it actually made: less than asked when the pantry no
 * longer holds what the list counted on. The row keeps those moves, so that
 * undoing them later gives back exactly what was taken, to the rows it was
 * taken from.
 */
import type { Unit } from '@diet-app/shared';
import { convertUnit, UnitConversionError, type ConvertibleIngredient } from './units.js';

/** One pantry row of an ingredient. */
export interface PantryRow {
  unit: Unit;
  quantity: number;
  bestBefore: Date | null;
}

/** A change made to the row of one unit, in that unit. Negative: taken out. */
export interface PantryMove {
  unit: Unit;
  quantity: number;
  /**
   * The best-before date (yyyy-mm-dd) of a row the move took from, kept so
   * that a row the move emptied can be given back with its date.
   */
  bestBefore?: string;
}

export interface Settlement {
  /** The rows afterwards. A row that was emptied is gone. */
  rows: PantryRow[];
  /** Everything the owner has done to the pantry, after this change: its ledger. */
  moves: PantryMove[];
  /** The change actually made, in the canonical unit. Never beyond what was asked. */
  applied: number;
}

/** An ingredient as the pantry needs to know it. */
export type PantryIngredient = ConvertibleIngredient & {
  /** Set when the ingredient is counted in pieces of its own (eggs, slices, cloves). */
  displayUnit?: string | null;
};

/** Quantities closer than this are the same quantity: the noise of converting units. */
const EPSILON = 1e-6;

/** The order units are visited in when nothing else decides: fixed, so that results are reproducible. */
const UNIT_ORDER: readonly Unit[] = ['g', 'ml', 'piece'];

const clean = (quantity: number): number => Math.round(quantity * 1e6) / 1e6;

/** `quantity` of `unit` in the canonical unit, or null when the ingredient cannot be converted from it. */
function canonical(quantity: number, unit: Unit, ingredient: PantryIngredient): number | null {
  try {
    return convertUnit(quantity, unit, ingredient.canonicalUnit, ingredient);
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return null;
  }
}

/** The inverse: a canonical quantity in `unit`. Only called for units `canonical` accepted. */
const inUnit = (quantity: number, unit: Unit, ingredient: PantryIngredient): number =>
  convertUnit(quantity, ingredient.canonicalUnit, unit, ingredient);

/**
 * How much of the ingredient the rows hold, in its canonical unit, and the
 * earliest best-before date among the rows that count.
 */
export function pantryStock(
  rows: readonly PantryRow[],
  ingredient: PantryIngredient,
): { quantity: number; bestBefore: Date | null } {
  let quantity = 0;
  let bestBefore: Date | null = null;
  for (const row of rows) {
    const amount = canonical(row.quantity, row.unit, ingredient);
    if (amount === null || amount <= EPSILON) continue;
    quantity += amount;
    if (row.bestBefore && (!bestBefore || row.bestBefore < bestBefore)) bestBefore = row.bestBefore;
  }
  return { quantity: clean(quantity), bestBefore };
}

/** What a ledger adds up to, in the canonical unit. */
export function netEffect(moves: readonly PantryMove[], ingredient: PantryIngredient): number {
  let total = 0;
  for (const move of moves) total += canonical(move.quantity, move.unit, ingredient) ?? 0;
  return clean(total);
}

/** The unit a new row of the ingredient is written in: pieces for what is counted in pieces. */
export function stockUnit(ingredient: PantryIngredient): Unit {
  const countable = Boolean(ingredient.displayUnit) && canonical(1, 'piece', ingredient) !== null;
  return countable ? 'piece' : ingredient.canonicalUnit;
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Bring the net effect of one owner on the pantry of one ingredient from what
 * `moves` record to `target` canonical units (negative: taken out of the
 * pantry; positive: put into it; zero: as if the owner had never touched it).
 *
 * Putting in: first back into the rows the owner took from, the one that keeps
 * longest first, so that what expires soonest stays the part that was used.
 * What is beyond that is new stock: it joins the row that holds the most, or
 * starts a row in the unit the ingredient is counted in.
 *
 * Taking out: first what the owner itself put in, from the rows it went to.
 * The rest comes out of the stock, the row that expires first going first.
 * Nothing goes below zero: when the pantry holds less than asked, less is
 * taken, and `applied` and `moves` say how much.
 */
export function settle(
  rows: readonly PantryRow[],
  ingredient: PantryIngredient,
  moves: readonly PantryMove[],
  target: number,
): Settlement {
  const stock = new Map<Unit, { quantity: number; bestBefore: Date | null }>();
  for (const row of rows) stock.set(row.unit, { quantity: row.quantity, bestBefore: row.bestBefore });
  const ledger = new Map<Unit, { quantity: number; bestBefore?: string }>();
  for (const move of moves) {
    const entry = ledger.get(move.unit);
    if (entry) {
      entry.quantity += move.quantity;
      entry.bestBefore ??= move.bestBefore;
    } else {
      ledger.set(move.unit, { quantity: move.quantity, bestBefore: move.bestBefore });
    }
  }
  const usable = (unit: Unit): boolean => canonical(1, unit, ingredient) !== null;
  const touched = new Set<Unit>();

  /** Change the row of `unit` by `amount` canonical units, and write it into the ledger. */
  const change = (unit: Unit, amount: number): void => {
    touched.add(unit);
    const delta = inUnit(amount, unit, ingredient);
    const row = stock.get(unit);
    const entry = ledger.get(unit) ?? { quantity: 0 };
    if (row) {
      row.quantity += delta;
      if (delta < 0 && row.bestBefore) entry.bestBefore ??= isoDate(row.bestBefore);
    } else {
      stock.set(unit, { quantity: delta, bestBefore: entry.bestBefore ? new Date(entry.bestBefore) : null });
    }
    entry.quantity += delta;
    ledger.set(unit, entry);
  };

  const diff = target - netEffect(moves, ingredient);
  let remaining = Math.abs(diff);

  if (diff > EPSILON) {
    const until = (unit: Unit): number => keepsUntil(stock.get(unit)?.bestBefore, ledger.get(unit)?.bestBefore);
    const taken = UNIT_ORDER.filter((unit) => usable(unit) && (ledger.get(unit)?.quantity ?? 0) < -EPSILON).sort(
      (a, b) => ascending(until(b), until(a)),
    );
    for (const unit of taken) {
      if (remaining <= EPSILON) break;
      const back = Math.min(remaining, canonical(-ledger.get(unit)!.quantity, unit, ingredient)!);
      change(unit, back);
      remaining -= back;
    }
    if (remaining > EPSILON) {
      let fullest: Unit | null = null;
      let most = EPSILON;
      for (const unit of UNIT_ORDER) {
        const held = stock.has(unit) ? canonical(stock.get(unit)!.quantity, unit, ingredient) : null;
        if (held !== null && held > most) {
          most = held;
          fullest = unit;
        }
      }
      change(fullest ?? stockUnit(ingredient), remaining);
      remaining = 0;
    }
  } else if (diff < -EPSILON) {
    const held = (unit: Unit): number => (stock.has(unit) ? Math.max(0, canonical(stock.get(unit)!.quantity, unit, ingredient) ?? 0) : 0);
    for (const unit of UNIT_ORDER) {
      if (remaining <= EPSILON) break;
      const put = ledger.get(unit)?.quantity ?? 0;
      if (put <= EPSILON || !usable(unit)) continue;
      const back = Math.min(remaining, canonical(put, unit, ingredient)!, held(unit));
      if (back <= EPSILON) continue;
      change(unit, -back);
      remaining -= back;
    }
    const soonestFirst = UNIT_ORDER.filter((unit) => usable(unit) && stock.has(unit)).sort((a, b) =>
      ascending(keepsUntil(stock.get(a)!.bestBefore), keepsUntil(stock.get(b)!.bestBefore)),
    );
    for (const unit of soonestFirst) {
      if (remaining <= EPSILON) break;
      const out = Math.min(remaining, held(unit));
      if (out <= EPSILON) continue;
      change(unit, -out);
      remaining -= out;
    }
  }

  // Back at zero with nothing left undone, the owner has no history with the
  // pantry: entries that only cancel each other out say nothing.
  if (Math.abs(target) <= EPSILON && remaining <= EPSILON) ledger.clear();

  return {
    // A row this change emptied is gone; one it did not touch stays as it was,
    // an empty one the owner of the pantry keeps on purpose included.
    rows: [...stock]
      .map(([unit, row]) => ({ unit, quantity: clean(row.quantity), bestBefore: row.bestBefore }))
      .filter((row) => row.quantity > EPSILON || !touched.has(row.unit)),
    moves: [...ledger]
      .map(([unit, entry]) => ({
        unit,
        quantity: clean(entry.quantity),
        ...(entry.bestBefore && entry.quantity < 0 ? { bestBefore: entry.bestBefore } : {}),
      }))
      .filter((move) => Math.abs(move.quantity) > EPSILON),
    // `|| 0`: nothing applied is zero, not minus zero.
    applied: clean(Math.sign(diff) * (Math.abs(diff) - remaining)) || 0,
  };
}

/** A date as a number for ordering; no date keeps longest. */
function keepsUntil(date: Date | null | undefined, fallback?: string): number {
  if (date) return date.getTime();
  return fallback ? new Date(fallback).getTime() : Number.POSITIVE_INFINITY;
}

const ascending = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);
