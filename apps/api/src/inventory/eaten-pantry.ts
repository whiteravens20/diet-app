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

/** Ids in the order every writer locks pantries in (by profile, then by food), the household list's among them. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What eating took off the pantry, as a meal or an entry keeps it: by ingredient, the moves made; of a part a shared
 * meal borrowed, the other pantry it came off (`profileId`), which giving it back returns it to.
 */
interface Taken {
  ingredientId: string;
  moves: PantryMove[];
  profileId?: string;
}

/** The other pantry of a joint plan's kitchen, which lends a shared meal what its own pantry lacks. */
interface Lender {
  profileId: string;
  profileName: string;
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
  /** Of a shared meal of a joint plan, the other profile's pantry, which lends what this one lacks; null otherwise. */
  lender: Lender | null;
}

const Ledger = z.array(
  z.object({
    ingredientId: z.string().uuid(),
    moves: z.unknown(),
    profileId: z.string().uuid().optional(),
  }),
);

/** A ledger as a meal or an entry keeps it, read back; anything else is nothing taken. */
export function readLedger(stored: unknown): Taken[] {
  const parsed = Ledger.safeParse(stored);
  return parsed.success
    ? parsed.data.map((one) => ({
        ingredientId: one.ingredientId,
        moves: readMoves(one.moves),
        ...(one.profileId ? { profileId: one.profileId } : {}),
      }))
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

/** Every pantry `eatings` take from or took from: their own and their lenders', in the order they are locked. */
const pantriesOf = (eatings: readonly Eating[]): string[] =>
  [
    ...new Set(
      eatings.flatMap((eating) => [
        eating.profileId,
        ...(eating.lender ? [eating.lender.profileId] : []),
        ...eating.ledger.flatMap((one) => (one.profileId ? [one.profileId] : [])),
      ]),
    ),
  ].sort(byId);

/** What each eating offering takes of a food: of its own pantry, and borrowed of its lender's. */
interface Share {
  own: number;
  borrowed: number;
}

/**
 * What each of `eatings` that offers takes of each food it ate, out of `stock` (pantry by profile, then food), as it is
 * shown (`pantryTake`): first every eating's own part, the lesser of what it ate and what its pantry holds; then of
 * what an eating still lacks, the lesser of that and what its lender's pantry holds after its own part. No food is
 * counted twice: what one takes is no longer there for the next.
 */
function sharesOf(
  eatings: readonly Eating[],
  stock: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ingredients: ReadonlyMap<string, Parameters<typeof pantryTake>[1] & { id: string }>,
): Map<string, Share>[] {
  const left = new Map([...stock].map(([profileId, held]) => [profileId, new Map(held)]));
  const take = (profileId: string, ingredientId: string, wanted: number): number => {
    const ingredient = ingredients.get(ingredientId);
    const there = left.get(profileId)?.get(ingredientId) ?? 0;
    if (!ingredient || wanted <= 0 || there <= 0) return 0;
    const taken = pantryTake(Math.min(wanted, there), ingredient);
    left.get(profileId)!.set(ingredientId, there - taken);
    return taken;
  };
  const shares = eatings.map((eating) =>
    eating.offering
      ? new Map(
          [...eating.eaten].map(([ingredientId, amount]) => [
            ingredientId,
            { own: take(eating.profileId, ingredientId, amount), borrowed: 0 },
          ]),
        )
      : new Map<string, Share>(),
  );
  eatings.forEach((eating, at) => {
    if (!eating.offering || !eating.lender) return;
    for (const [ingredientId, share] of shares[at]!)
      share.borrowed = take(
        eating.lender.profileId,
        ingredientId,
        (eating.eaten.get(ingredientId) ?? 0) - share.own,
      );
  });
  return shares;
}

/**
 * What `eating` would take off its pantry now, where it is offered, and what it took, named in `locale`
 * (`eatenPantries` of it alone).
 */
export async function eatenPantry(
  db: Tx,
  eating: Eating,
  today: string,
  locale: Locale,
): Promise<EatenPantry> {
  return (await eatenPantries(db, [eating], today, locale))[0]!;
}

/**
 * What `eatings` (one meal or entry, or both portions of a shared meal) would take off the pantry now, worked out
 * together (`sharesOf`), and what each took, named in `locale`. An offer takes of each food the lesser of what was
 * eaten and what the pantry holds of it fresh, and where a shared meal's own pantry lacks it, of what the other pantry
 * of the kitchen still holds, said as borrowed; frozen stock is not taken.
 */
export async function eatenPantries(
  db: Tx,
  eatings: readonly Eating[],
  today: string,
  locale: Locale,
): Promise<EatenPantry[]> {
  const ids = [
    ...new Set(
      eatings.flatMap((eating) => [
        ...eating.eaten.keys(),
        ...eating.ledger.map((one) => one.ingredientId),
      ]),
    ),
  ];
  if (ids.length === 0)
    return eatings.map((eating) => ({ profileName: eating.profileName, offer: [], taken: [] }));
  const pantries = pantriesOf(eatings);
  const [rows, stocks, names] = await Promise.all([
    db.ingredient.findMany({
      where: { id: { in: ids } },
      select: { ...INGREDIENT, translations: { where: { locale }, select: { name: true } } },
    }),
    Promise.all(pantries.map((profileId) => freshStock(db, profileId, ids, today))),
    db.profile.findMany({ where: { id: { in: pantries } }, select: { id: true, name: true } }),
  ]);
  const ingredients = new Map(rows.map((row) => [row.id, row]));
  const stock = new Map(pantries.map((profileId, at) => [profileId, stocks[at]!]));
  const nameOf = new Map(names.map((profile) => [profile.id, profile.name]));
  const shares = sharesOf(eatings, stock, ingredients);
  const byName = (a: EatenFromPantry, b: EatenFromPantry) => a.name.localeCompare(b.name, locale);
  return eatings.map((eating, at) => {
    const line = (
      ingredient: (typeof rows)[number],
      eatenOf: number,
      taken: number,
      borrowed: { amount: number; from: string } | null,
    ): EatenFromPantry => ({
      ingredientId: ingredient.id,
      name: ingredient.translations[0]?.name ?? ingredient.name,
      // Rounded as it is taken, so that where the pantries hold enough the two say the same.
      eaten: displayPantry(pantryTake(eatenOf, ingredient) || eatenOf, ingredient),
      held: displayPantry(stock.get(eating.profileId)?.get(ingredient.id) ?? 0, ingredient),
      taken: displayPantry(taken, ingredient),
      borrowed: borrowed
        ? { amount: displayPantry(borrowed.amount, ingredient), from: borrowed.from }
        : null,
    });
    const offer = [...shares[at]!].flatMap(([ingredientId, share]) => {
      const ingredient = ingredients.get(ingredientId);
      const taken = share.own + share.borrowed;
      if (!ingredient || taken <= 0) return [];
      return [
        line(
          ingredient,
          eating.eaten.get(ingredientId) ?? taken,
          taken,
          share.borrowed > 0 ? { amount: share.borrowed, from: eating.lender!.profileName } : null,
        ),
      ];
    });
    // What it took, by food: its own pantry's part and the part another pantry lent, together; of a pantry no longer
    // there, nothing, since nothing can go back to it.
    const tookOf = new Map<string, { taken: number; borrowed: number; from: string | null }>();
    for (const one of eating.ledger) {
      const ingredient = ingredients.get(one.ingredientId);
      if (!ingredient || (one.profileId && !nameOf.has(one.profileId))) continue;
      const amount = -one.moves.reduce(
        (sum, move) => sum + (canonical(move.quantity, move.unit, ingredient) ?? 0),
        0,
      );
      const was = tookOf.get(one.ingredientId) ?? { taken: 0, borrowed: 0, from: null };
      tookOf.set(one.ingredientId, {
        taken: was.taken + amount,
        borrowed: was.borrowed + (one.profileId ? amount : 0),
        from: one.profileId ? (nameOf.get(one.profileId) ?? null) : was.from,
      });
    }
    const taken = [...tookOf].flatMap(([ingredientId, took]) => {
      const ingredient = ingredients.get(ingredientId)!;
      if (took.taken <= 0) return [];
      return [
        line(
          ingredient,
          eating.eaten.get(ingredientId) ?? took.taken,
          took.taken,
          took.borrowed > 0 && took.from !== null
            ? { amount: took.borrowed, from: took.from }
            : null,
        ),
      ];
    });
    return {
      profileName: eating.profileName,
      offer: offer.sort(byName),
      taken: taken.sort(byName),
    };
  });
}

/**
 * Take what `eating` ate off its pantry, where that is offered (`takeEatenTogether` of it alone). The ledger of what it
 * took; empty where nothing was offered or the pantries held none of it.
 */
export async function takeEaten(tx: Tx, eating: Eating, today: string): Promise<Taken[]> {
  return (await takeEatenTogether(tx, [eating], today))[0]!;
}

/**
 * Take what `eatings` ate off the pantry, where that is offered, as a list's tick takes (`settlePantry`) and as they
 * offer it (`sharesOf`), counted under the locks of every pantry they take from (by profile, then by food, as a
 * household list takes them): of each food its own pantry's part, and the part a lender's pantry gives, kept apart.
 * The ledger of each eating, in their order.
 */
export async function takeEatenTogether(
  tx: Tx,
  eatings: readonly Eating[],
  today: string,
): Promise<Taken[][]> {
  const offering = eatings.filter((eating) => eating.offering);
  if (offering.length === 0) return eatings.map(() => []);
  const ids = [...new Set(offering.flatMap((eating) => [...eating.eaten.keys()]))].sort(byId);
  const pantries = pantriesOf(offering);
  for (const profileId of pantries)
    for (const ingredientId of ids) await lockPantry(tx, profileId, ingredientId);
  const [rows, stocks] = await Promise.all([
    tx.ingredient.findMany({ where: { id: { in: ids } }, select: INGREDIENT }),
    Promise.all(pantries.map((profileId) => freshStock(tx, profileId, ids, today))),
  ]);
  const ingredients = new Map(rows.map((row) => [row.id, row]));
  const stock = new Map(pantries.map((profileId, at) => [profileId, stocks[at]!]));
  const shares = sharesOf(eatings, stock, ingredients);
  const ledgers: Taken[][] = [];
  for (const [at, eating] of eatings.entries()) {
    const ledger: Taken[] = [];
    for (const ingredientId of ids) {
      const share = shares[at]!.get(ingredientId);
      const ingredient = ingredients.get(ingredientId);
      if (!share || !ingredient) continue;
      if (share.own > 0) {
        const moves = await settlePantry(
          tx,
          eating.profileId,
          ingredient,
          [],
          -share.own,
          new Set(),
          today,
          true,
        );
        if (moves.length > 0) ledger.push({ ingredientId, moves });
      }
      if (share.borrowed > 0 && eating.lender) {
        const lender = eating.lender.profileId;
        const moves = await settlePantry(
          tx,
          lender,
          ingredient,
          [],
          -share.borrowed,
          new Set(),
          today,
          true,
        );
        if (moves.length > 0) ledger.push({ ingredientId, moves, profileId: lender });
      }
    }
    ledgers.push(ledger);
  }
  return ledgers;
}

/**
 * Give back what `ledger` took off the pantry of `profileId`, and the part another pantry lent to that pantry while it
 * is there: every move undone, to the rows it was taken from, under the locks of every pantry it touches, all taken
 * first (by profile, then by food).
 */
export async function giveBackEaten(
  tx: Tx,
  profileId: string,
  ledger: readonly Taken[],
): Promise<void> {
  const all = ledger.map((one) => ({ pantry: one.profileId ?? profileId, one }));
  if (all.length === 0) return;
  const there = new Set(
    (
      await tx.profile.findMany({
        where: { id: { in: [...new Set(all.map(({ pantry }) => pantry))] } },
        select: { id: true },
      })
    ).map((profile) => profile.id),
  );
  const back = all
    .filter(({ pantry }) => there.has(pantry))
    .sort((a, b) => byId(a.pantry, b.pantry) || byId(a.one.ingredientId, b.one.ingredientId));
  for (const { pantry, one } of back) await lockPantry(tx, pantry, one.ingredientId);
  const ingredients = new Map(
    (
      await tx.ingredient.findMany({
        where: { id: { in: [...new Set(back.map(({ one }) => one.ingredientId))] } },
        select: INGREDIENT,
      })
    ).map((row) => [row.id, row]),
  );
  for (const { pantry, one } of back) {
    const ingredient = ingredients.get(one.ingredientId);
    if (ingredient) await settlePantry(tx, pantry, ingredient, one.moves, 0);
  }
}
