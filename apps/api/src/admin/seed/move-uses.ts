// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What uses one ingredient, moved over to another: the lines of recipes and of
 * the drafts not shipped yet, the pantry, the ingredients profiles like, avoid
 * or leave out, and the rows of shopping lists. A catalogue update moves what
 * uses a food of an import to the curated ingredient that is that food; the
 * administrator moves what uses a retired ingredient to one still in the
 * catalogue.
 *
 * An amount stays the amount it was. One held in a unit the new ingredient
 * cannot be weighed in is put in grams with what the old one knew of itself
 * (the grams of a piece, its density). Where even that cannot be done, nothing
 * is moved, and the units that stood in the way are said.
 */
import type { Prisma, ProductCategory, Unit } from '@prisma/client';
import type { PantryMove } from '../../engine/pantry.js';
import { convertUnit, toCanonical, type ConvertibleIngredient } from '../../engine/units.js';
import { lockPantry } from '../../inventory/pantry-store.js';

type Db = Prisma.TransactionClient;

/** An ingredient as moving its uses needs to know it. */
export interface MovableIngredient extends ConvertibleIngredient {
  id: string;
  slug: string | null;
  name: string;
  category: ProductCategory;
}

/** What `select` reads of an ingredient for `moveUses`. */
export const MOVABLE = {
  id: true,
  slug: true,
  name: true,
  category: true,
  canonicalUnit: true,
  gramsPerPiece: true,
  density: true,
} as const;

/** How many uses of each kind were moved. */
export interface MovedUses {
  recipeLines: number;
  draftLines: number;
  pantryRows: number;
  preferences: number;
  shoppingRows: number;
}

/** The uses could not be moved: the new ingredient cannot be weighed in these units, not even through grams. */
export class UnitsStandInTheWay extends Error {
  constructor(readonly units: Unit[]) {
    super(`cannot be weighed in ${units.join(', ')}`);
  }
}

/** A draft's line as it is kept. */
interface DraftLine {
  slug: string;
  quantity: number;
  unit: Unit;
  note?: string | null;
}

/** The factor and unit an amount of `from` in `unit` is held in for `to`; null where there are none. */
function restated(
  unit: Unit,
  from: MovableIngredient,
  to: MovableIngredient,
): { factor: number; unit: Unit } | null {
  if (takes(to, unit)) return { factor: 1, unit };
  try {
    const grams = convertUnit(1, unit, 'g', from);
    return takes(to, 'g') ? { factor: grams, unit: 'g' } : null;
  } catch {
    return null;
  }
}

function takes(ingredient: MovableIngredient, unit: Unit): boolean {
  try {
    toCanonical(1, unit, ingredient);
    return true;
  } catch {
    return false;
  }
}

/** An amount put in grams by a factor keeps a tenth of a gram; one kept as it was stays exact. */
const scaled = (quantity: number, factor: number): number =>
  factor === 1 ? quantity : Math.round(quantity * factor * 10) / 10;

const earlier = (a: Date | null, b: Date | null): Date | null =>
  a === null ? b : b === null ? a : a < b ? a : b;

/**
 * Move every use of `from` to `to`, or nothing at all: throws
 * `UnitsStandInTheWay` before anything is written when an amount could not be
 * held for `to`. `from` itself is left as it is.
 */
export async function moveUses(
  db: Db,
  from: MovableIngredient,
  // An ingredient of the catalogue, which drafts name by its slug.
  to: MovableIngredient & { slug: string },
): Promise<MovedUses> {
  const [lines, drafts, pantry, rows] = await Promise.all([
    db.recipeIngredient.findMany({
      where: { ingredientId: from.id },
      select: { id: true, quantity: true, unit: true },
    }),
    from.slug === null
      ? Promise.resolve([])
      : db.recipeDraft.findMany({
          where: { status: { not: 'SHIPPED' } },
          select: { id: true, ingredientsJson: true },
        }),
    db.inventoryItem.findMany({
      where: { ingredientId: from.id },
      select: { id: true, profileId: true, quantity: true, unit: true, bestBefore: true },
    }),
    db.shoppingListItem.findMany({
      where: { ingredientId: from.id },
      select: {
        id: true,
        totalQuantity: true,
        unit: true,
        alreadyHaveQuantity: true,
        purchasedQuantity: true,
        pantryMoves: true,
      },
    }),
  ]);
  const draftsNaming = drafts
    .map((draft) => ({ id: draft.id, lines: draft.ingredientsJson as unknown as DraftLine[] }))
    .filter((draft) => draft.lines.some((line) => line.slug === from.slug));
  const movesOf = (row: (typeof rows)[number]) => row.pantryMoves as unknown as PantryMove[];

  // Every unit an amount of `from` is held in, each restated once: nothing is written unless all can be.
  const units = new Set<Unit>([
    ...lines.map((line) => line.unit),
    ...draftsNaming.flatMap((draft) =>
      draft.lines.filter((line) => line.slug === from.slug).map((line) => line.unit),
    ),
    ...pantry.map((row) => row.unit),
    ...rows.flatMap((row) => [row.unit, ...movesOf(row).map((move) => move.unit)]),
  ]);
  const ways = new Map([...units].map((unit) => [unit, restated(unit, from, to)]));
  const blocked = [...ways].filter(([, way]) => way === null).map(([unit]) => unit);
  if (blocked.length > 0) throw new UnitsStandInTheWay(blocked.sort());
  const way = (unit: Unit) => ways.get(unit)!;

  for (const line of lines) {
    const { factor, unit } = way(line.unit);
    await db.recipeIngredient.update({
      where: { id: line.id },
      data: { ingredientId: to.id, quantity: scaled(line.quantity, factor), unit },
    });
  }

  let draftLines = 0;
  for (const draft of draftsNaming) {
    const next = draft.lines.map((line) => {
      if (line.slug !== from.slug) return line;
      draftLines += 1;
      const { factor, unit } = way(line.unit);
      return { ...line, slug: to.slug, quantity: scaled(line.quantity, factor), unit };
    });
    await db.recipeDraft.update({
      where: { id: draft.id },
      data: { ingredientsJson: next as unknown as Prisma.InputJsonValue },
    });
  }

  // A profile's row of `from` joins its row of `to` in the same unit, when it has one.
  for (const row of pantry) {
    await lockPantry(db, row.profileId, from.id);
    await lockPantry(db, row.profileId, to.id);
    const { factor, unit } = way(row.unit);
    const quantity = scaled(row.quantity, factor);
    const joined = await db.inventoryItem.findUnique({
      where: {
        profileId_ingredientId_unit: { profileId: row.profileId, ingredientId: to.id, unit },
      },
    });
    if (joined) {
      await db.inventoryItem.update({
        where: { id: joined.id },
        data: {
          quantity: joined.quantity + quantity,
          // What runs out first decides: the sooner of the two dates.
          bestBefore: earlier(joined.bestBefore, row.bestBefore),
        },
      });
      await db.inventoryItem.delete({ where: { id: row.id } });
    } else {
      await db.inventoryItem.update({
        where: { id: row.id },
        data: { ingredientId: to.id, quantity, unit },
      });
    }
  }

  const preferences = await db.profilePreference.findMany({
    where: {
      OR: [
        { favoriteIngredientIds: { has: from.id } },
        { excludedIngredientIds: { has: from.id } },
        { dislikedIngredientIds: { has: from.id } },
      ],
    },
    select: {
      id: true,
      favoriteIngredientIds: true,
      excludedIngredientIds: true,
      dislikedIngredientIds: true,
    },
  });
  const swapped = (ids: string[]) => [...new Set(ids.map((id) => (id === from.id ? to.id : id)))];
  for (const preference of preferences) {
    await db.profilePreference.update({
      where: { id: preference.id },
      data: {
        favoriteIngredientIds: swapped(preference.favoriteIngredientIds),
        excludedIngredientIds: swapped(preference.excludedIngredientIds),
        dislikedIngredientIds: swapped(preference.dislikedIngredientIds),
      },
    });
  }

  // A row of a list is shown by its ingredient's name and filed under its aisle: the new one's.
  for (const row of rows) {
    const { factor, unit } = way(row.unit);
    await db.shoppingListItem.update({
      where: { id: row.id },
      data: {
        ingredientId: to.id,
        name: to.name,
        category: to.category,
        unit,
        totalQuantity: scaled(row.totalQuantity, factor),
        alreadyHaveQuantity: scaled(row.alreadyHaveQuantity, factor),
        purchasedQuantity:
          row.purchasedQuantity === null ? null : scaled(row.purchasedQuantity, factor),
        pantryMoves: movesOf(row).map((move) => {
          const moved = way(move.unit);
          return { ...move, unit: moved.unit, quantity: scaled(move.quantity, moved.factor) };
        }) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  return {
    recipeLines: lines.length,
    draftLines,
    pantryRows: pantry.length,
    preferences: preferences.length,
    shoppingRows: rows.length,
  };
}
