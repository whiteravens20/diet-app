// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What eating does to the pantry on a day no shopping list covers ("Zdejmij ze spiżarni to, co zjedzono"): a meal
 * marked eaten, or an entry of the diary of an ingredient or a recipe, offers to take what it ate off the pantry,
 * and takes it only when the user confirms, as a list's tick takes (`settlePantry`); what it took is kept with it, so
 * that it takes nothing twice, and giving it back undoes it. On a day a list covers, the list is the pantry's ledger.
 */
import type { EatenFromPantry, EatenPantry, Locale } from '@diet-app/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { convertUnit, UnitConversionError } from '../engine/index.js';
import { displayPantry, pantryTake } from '../engine/display.js';
import type { PantryMove } from '../engine/pantry.js';
import {
  countsAtHome,
  lockPantry,
  readMoves,
  settlePantry,
  stockByIngredient,
} from './pantry-store.js';

type Tx = Prisma.TransactionClient;

/** What eating took off the pantry, as a meal or an entry keeps it: by ingredient, the moves made. */
interface Taken {
  ingredientId: string;
  moves: PantryMove[];
}

/** What eating a meal or an entry comes to for the pantry of its profile. */
export interface Eating {
  profileId: string;
  /** The profile's name, which says whose pantry it is. */
  profileName: string;
  /** What it ate, by ingredient, in the ingredient's canonical unit. */
  eaten: ReadonlyMap<string, number>;
  /** What it took off the pantry, as it keeps it. */
  ledger: readonly Taken[];
  /** Whether taking it is offered: a day no list covers, eaten, and nothing taken yet. */
  offering: boolean;
}

const Ledger = z.array(z.object({ ingredientId: z.string().uuid(), moves: z.unknown() }));

/** A ledger as a meal or an entry keeps it, read back; anything else is nothing taken. */
export function readLedger(stored: unknown): Taken[] {
  const parsed = Ledger.safeParse(stored);
  return parsed.success
    ? parsed.data.map((one) => ({ ingredientId: one.ingredientId, moves: readMoves(one.moves) }))
    : [];
}

/** A ledger as a meal or an entry stores it. */
export const storedLedger = (ledger: readonly Taken[]): Prisma.InputJsonValue =>
  ledger as unknown as Prisma.InputJsonValue;

/** Whether a shopping list of a plan of `profileId` covers `date`: that list is the pantry's ledger of the day. */
export async function listCovers(
  db: Pick<Tx, 'shoppingList'>,
  profileId: string,
  date: Date,
): Promise<boolean> {
  return (
    (await db.shoppingList.count({
      where: { plan: { profileId }, fromDate: { lte: date }, toDate: { gte: date } },
    })) > 0
  );
}

/** What converting an ingredient, showing an amount of it and naming it reads. */
const INGREDIENT = {
  id: true,
  name: true,
  canonicalUnit: true,
  gramsPerPiece: true,
  density: true,
  perishable: true,
  packSize: true,
  displayUnit: true,
} as const;

/** A quantity in an ingredient's canonical unit, or null where it cannot be converted. */
export function canonical(
  quantity: number,
  unit: string,
  ingredient: Parameters<typeof convertUnit>[3] & { canonicalUnit: string },
): number | null {
  try {
    return convertUnit(
      quantity,
      unit as Parameters<typeof convertUnit>[1],
      ingredient.canonicalUnit as Parameters<typeof convertUnit>[2],
      ingredient,
    );
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return null;
  }
}

/** What the pantry of `profileId` holds fresh of each of `ids` that counts at home on `today`: what eating takes from. */
const freshStock = (db: Tx, profileId: string, ids: readonly string[], today: string) =>
  stockByIngredient(db, profileId, {
    AND: [countsAtHome(today), { frozen: false }, { ingredientId: { in: [...ids] } }],
  });

/**
 * What `eating` would take off its pantry now, where it is offered, and what it took, named in `locale`. An offer
 * takes of each food the lesser of what was eaten and what the pantry holds of it fresh, as it is shown
 * (`pantryTake`); frozen stock is not taken.
 */
export async function eatenPantry(
  db: Tx,
  eating: Eating,
  today: string,
  locale: Locale,
): Promise<EatenPantry> {
  const { eaten, ledger, offering, profileName } = eating;
  const ids = [...new Set([...eaten.keys(), ...ledger.map((one) => one.ingredientId)])];
  if (ids.length === 0) return { profileName, offer: [], taken: [] };
  const [rows, held] = await Promise.all([
    db.ingredient.findMany({
      where: { id: { in: ids } },
      select: { ...INGREDIENT, translations: { where: { locale }, select: { name: true } } },
    }),
    freshStock(db, eating.profileId, ids, today),
  ]);
  const ingredients = new Map(rows.map((row) => [row.id, row]));
  const line = (
    ingredient: (typeof rows)[number],
    eatenOf: number,
    taken: number,
  ): EatenFromPantry => ({
    ingredientId: ingredient.id,
    name: ingredient.translations[0]?.name ?? ingredient.name,
    // Rounded as it is taken, so that where the pantry holds enough the two say the same.
    eaten: displayPantry(pantryTake(eatenOf, ingredient) || eatenOf, ingredient),
    held: displayPantry(held.get(ingredient.id) ?? 0, ingredient),
    taken: displayPantry(taken, ingredient),
  });
  const offer = offering
    ? [...eaten].flatMap(([ingredientId, amount]) => {
        const ingredient = ingredients.get(ingredientId);
        if (!ingredient) return [];
        const take = pantryTake(Math.min(amount, held.get(ingredientId) ?? 0), ingredient);
        return take > 0 ? [line(ingredient, amount, take)] : [];
      })
    : [];
  const taken = ledger.flatMap((one) => {
    const ingredient = ingredients.get(one.ingredientId);
    if (!ingredient) return [];
    const amount = -one.moves.reduce(
      (sum, move) => sum + (canonical(move.quantity, move.unit, ingredient) ?? 0),
      0,
    );
    return amount > 0 ? [line(ingredient, eaten.get(one.ingredientId) ?? amount, amount)] : [];
  });
  const byName = (a: EatenFromPantry, b: EatenFromPantry) => a.name.localeCompare(b.name, locale);
  return { profileName, offer: offer.sort(byName), taken: taken.sort(byName) };
}

/**
 * Take what `eating` ate off its pantry, where that is offered, as a list's tick takes (`settlePantry`): of each food
 * the lesser of what was eaten and what the pantry holds of it fresh, counted under the pantry's lock, as it is shown.
 * The ledger of what it took; empty where nothing was offered or the pantry held none of it.
 */
export async function takeEaten(tx: Tx, eating: Eating, today: string): Promise<Taken[]> {
  if (!eating.offering) return [];
  const ids = [...eating.eaten.keys()].sort((a, b) => a.localeCompare(b));
  for (const ingredientId of ids) await lockPantry(tx, eating.profileId, ingredientId);
  const [rows, held] = await Promise.all([
    tx.ingredient.findMany({ where: { id: { in: ids } }, select: INGREDIENT }),
    freshStock(tx, eating.profileId, ids, today),
  ]);
  const ledger: Taken[] = [];
  for (const ingredient of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const take = pantryTake(
      Math.min(eating.eaten.get(ingredient.id) ?? 0, held.get(ingredient.id) ?? 0),
      ingredient,
    );
    if (take <= 0) continue;
    const moves = await settlePantry(
      tx,
      eating.profileId,
      ingredient,
      [],
      -take,
      new Set(),
      today,
      true,
    );
    if (moves.length > 0) ledger.push({ ingredientId: ingredient.id, moves });
  }
  return ledger;
}

/** Give back what `ledger` took off the pantry of `profileId`: every move undone, to the rows it was taken from. */
export async function giveBackEaten(
  tx: Tx,
  profileId: string,
  ledger: readonly Taken[],
): Promise<void> {
  for (const one of [...ledger].sort((a, b) => a.ingredientId.localeCompare(b.ingredientId))) {
    await lockPantry(tx, profileId, one.ingredientId);
    const ingredient = await tx.ingredient.findUnique({
      where: { id: one.ingredientId },
      select: INGREDIENT,
    });
    if (!ingredient) continue;
    await settlePantry(tx, profileId, ingredient, one.moves, 0);
  }
}
