// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MAX_PANTRY_ROWS, MAX_QUANTITY, type Unit } from '@diet-app/shared';
import { z } from 'zod';
import { pantryStock, settle, type PantryIngredient, type PantryMove } from '../engine/pantry.js';

/**
 * The pantry in the database: the part of `engine/pantry.ts` that reads and
 * writes rows.
 *
 * Everything that changes the pantry rows of one ingredient of one profile
 * holds `lockPantry` first: a shopping row being ticked, a list being removed,
 * the user adding stock by hand. Under that lock a change reads the rows,
 * works out the new ones and writes them, and no other change of the same
 * ingredient can happen in between. Two requests can therefore neither both
 * create the row of a unit nor overwrite each other's quantity.
 */

/** Hold the pantry of one ingredient of one profile until the transaction ends. */
export function lockPantry(tx: Prisma.TransactionClient, profileId: string, ingredientId: string): Promise<number> {
  return tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pantry:${profileId}:${ingredientId}`}, 0))`);
}

/**
 * Hold the pantries of several ingredients of one profile until the
 * transaction ends: one statement, which takes them one after another in the
 * order of their ids. That is the order every writer takes them in, so two
 * that want the same ones wait for each other and neither holds what the
 * other needs.
 */
export async function lockPantries(tx: Prisma.TransactionClient, profileId: string, ingredientIds: readonly string[]): Promise<void> {
  const keys = [...new Set(ingredientIds)].sort().map((ingredientId) => `pantry:${profileId}:${ingredientId}`);
  if (keys.length === 0) return;
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(wanted.key, 0)) FROM unnest(${keys}::text[]) WITH ORDINALITY AS wanted(key, place) ORDER BY wanted.place`,
  );
}

/**
 * Refuse a new row for a pantry that holds as many as a pantry may. Whoever
 * makes a row asks first. Rows of different ingredients are made without
 * waiting for each other, so requests that arrive together can pass the most
 * by as many as they are, and no further: the next one is refused.
 */
export async function assertRoomInPantry(tx: Prisma.TransactionClient, profileId: string): Promise<void> {
  if ((await tx.inventoryItem.count({ where: { profileId } })) >= MAX_PANTRY_ROWS) {
    throw new ConflictException({
      error: 'PANTRY_FULL',
      message: `A pantry holds at most ${MAX_PANTRY_ROWS} rows. Remove one to add another.`,
    });
  }
}

const Moves = z.array(
  z.object({
    unit: z.enum(['g', 'ml', 'piece']),
    quantity: z.number().finite(),
    bestBefore: z.string().date().optional(),
  }),
);

/** The ledger a shopping row stores, read back. Anything that is not one counts as no moves. */
export function readMoves(stored: unknown): PantryMove[] {
  const parsed = Moves.safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/**
 * Bring the net effect of the owner of `moves` on the pantry of one ingredient
 * to `target` canonical units, write the rows that changed and return the
 * owner's ledger as it is afterwards. The caller holds `lockPantry`.
 */
export async function settlePantry(
  tx: Prisma.TransactionClient,
  profileId: string,
  ingredient: PantryIngredient & { id: string },
  moves: readonly PantryMove[],
  target: number,
): Promise<PantryMove[]> {
  const before = await tx.inventoryItem.findMany({
    where: { profileId, ingredientId: ingredient.id },
    select: { id: true, unit: true, quantity: true, bestBefore: true },
  });
  const result = settle(before, ingredient, moves, target);

  const after = new Map(result.rows.map((row) => [row.unit, row]));
  for (const row of before) {
    const next = after.get(row.unit);
    if (!next) {
      await tx.inventoryItem.delete({ where: { id: row.id } });
    } else if (next.quantity !== row.quantity) {
      await tx.inventoryItem.update({ where: { id: row.id }, data: { quantity: next.quantity } });
    }
    after.delete(row.unit);
  }
  for (const row of after.values()) {
    await assertRoomInPantry(tx, profileId);
    await tx.inventoryItem.create({
      data: { profileId, ingredientId: ingredient.id, unit: row.unit, quantity: row.quantity, bestBefore: row.bestBefore },
    });
  }
  return result.moves;
}

/**
 * What a profile holds of each ingredient, in the ingredient's canonical unit,
 * across its pantry rows of every unit. An ingredient it holds nothing of is
 * absent. `only` narrows the rows that count.
 */
export async function stockByIngredient(
  db: Pick<Prisma.TransactionClient, 'inventoryItem'>,
  profileId: string,
  only: Prisma.InventoryItemWhereInput = {},
): Promise<Map<string, number>> {
  const rows = await db.inventoryItem.findMany({
    where: { profileId, ...only },
    include: { ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true } } },
  });
  const byIngredient = new Map<string, typeof rows>();
  for (const row of rows) byIngredient.set(row.ingredientId, [...(byIngredient.get(row.ingredientId) ?? []), row]);
  const stock = new Map<string, number>();
  for (const [ingredientId, group] of byIngredient) {
    const { quantity } = pantryStock(group, group[0]!.ingredient);
    if (quantity > 0) stock.set(ingredientId, quantity);
  }
  return stock;
}

/**
 * The stock that goes off between two dates, both included. What went off
 * before `from` is past saving, and what has no date does not go off.
 */
export function stockExpiringBetween(
  db: Pick<Prisma.TransactionClient, 'inventoryItem'>,
  profileId: string,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  return stockByIngredient(db, profileId, { bestBefore: { gte: from, lte: to } });
}

/** Refuse a quantity beyond what a row of its unit may hold. */
export function assertWithinCeiling(quantity: number, unit: Unit): void {
  if (quantity > MAX_QUANTITY[unit]) {
    throw new BadRequestException({
      error: 'QUANTITY_TOO_LARGE',
      message: `A quantity may be at most ${MAX_QUANTITY[unit]} ${unit}.`,
    });
  }
}
