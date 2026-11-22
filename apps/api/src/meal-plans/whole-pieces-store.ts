// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Prisma } from '@prisma/client';
import { PlanOptions, type Unit } from '@diet-app/shared';
import { z } from 'zod';
import { convertUnit, UnitConversionError } from '../engine/units.js';
import {
  linkedPots,
  wholePieceFactors,
  WHOLE_PIECE_SLUGS,
  type PieceUse,
  type PotTake,
} from '../engine/whole-pieces.js';
import { plateOfMeal, plateShare } from './plan-days.js';
import { cookingsOf } from './plan-menu.js';

/** The lines of a recipe with an ingredient used whole, and what a pot needs of each: for a read's `include`. */
export const WHOLE_LINES = {
  where: { ingredient: { slug: { in: [...WHOLE_PIECE_SLUGS] } } },
  select: {
    quantity: true,
    unit: true,
    ingredient: {
      select: {
        id: true,
        slug: true,
        name: true,
        category: true,
        proteinKind: true,
        canonicalUnit: true,
        gramsPerPiece: true,
        density: true,
        caloriesPer100: true,
        proteinPer100: true,
        fatPer100: true,
        carbsPer100: true,
        fiberPer100: true,
        sugarsPer100: true,
        saltPer100: true,
        saturatedFatPer100: true,
      },
    },
  },
} satisfies Prisma.RecipeIngredientFindManyArgs;

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** An amount of a line in another unit; null where the ingredient cannot be converted to it. */
function inUnit(
  quantity: number,
  from: Unit,
  to: Unit,
  ingredient: Parameters<typeof convertUnit>[3],
): number | null {
  try {
    return convertUnit(quantity, from, to, ingredient);
  } catch (err) {
    if (err instanceof UnitConversionError) return null;
    throw err;
  }
}

/** A planned meal as its pot is worked out from it. */
interface PotMeal {
  id: string;
  mealType: string;
  recipeId: string | null;
  servings: number;
  quantityScale: number;
  plate: unknown;
  source: string;
  wholePieces: boolean;
  /** What it took whole when it was eaten (`keptPiecesOf`); null where nothing is kept. */
  keptPieces: unknown;
  sharedMealId: string | null;
  /** Its dish both people eat is cooked apart, each portion a pot of its own; unknown for a plan read alone. */
  apart?: boolean | null;
  givenLeftoverId: string | null;
  leftoverFromDate: Date | null;
  leftoverFromMealType: string | null;
  recipe: WholeRecipe | null;
}

/** A plan as its pots are worked out from it: whether it is cooked ahead, and its days in order. */
export interface PotPlan {
  options: unknown;
  days: readonly { date: Date; meals: readonly PotMeal[] }[];
}

/**
 * The ingredients the planned meals named take whole, each with its pot's factor: the pots are
 * worked out from the plans the meals are of, from the plan of whoever shares a dish of them, and
 * from the plan a leftover of theirs went to or came from (`usesOfPlans`). One statement.
 */
export async function pieceUsesOf(
  db: Db,
  mealIds: readonly string[],
  scales: ReadonlyMap<string, number> = new Map(),
): Promise<Map<string, PieceUse[]>> {
  if (mealIds.length === 0) return new Map();
  // Each set of ids is worked out before the rows that use it (`= ANY(ARRAY(...))`), so that the planner knows how
  // few rows it reads and needs no compiling of the query; the meals of the plans are read once, those of a plan a
  // leftover links them to only where there is one, and the lines of eggs and tortillas from the two foods' side.
  const rows = await db.$queryRaw<PotRow[]>`
    WITH "asked" AS MATERIALIZED (
      SELECT d."planId", m."sharedMealId"
      FROM "PlannedMeal" m JOIN "MealPlanDay" d ON d."id" = m."dayId"
      WHERE m."id" = ANY(${[...mealIds]}::text[])
    ), "near" AS MATERIALIZED (
      SELECT "planId" FROM "asked"
      UNION
      SELECT d."planId" FROM "PlannedMeal" m JOIN "MealPlanDay" d ON d."id" = m."dayId"
      WHERE m."sharedMealId" = ANY(
        ARRAY(SELECT "sharedMealId" FROM "asked" WHERE "sharedMealId" IS NOT NULL)
      )
    ), "nearMeals" AS MATERIALIZED (
      SELECT d."planId", d."date", m."id", m."mealType", m."recipeId", m."servings", m."quantityScale", m."plate", m."source",
        m."wholePieces", m."keptPieces", m."sharedMealId", m."givenLeftoverId", m."leftoverFromDate", m."leftoverFromMealType"
      FROM "MealPlanDay" d JOIN "PlannedMeal" m ON m."dayId" = d."id"
      WHERE d."planId" = ANY(ARRAY(SELECT "planId" FROM "near"))
    ), "farther" AS MATERIALIZED (
      SELECT d."planId" FROM "PlannedMeal" l JOIN "MealPlanDay" d ON d."id" = l."dayId"
      WHERE l."id" = ANY(
        ARRAY(SELECT "givenLeftoverId" FROM "nearMeals" WHERE "givenLeftoverId" IS NOT NULL)
      )
      UNION
      SELECT d."planId" FROM "PlannedMeal" o JOIN "MealPlanDay" d ON d."id" = o."dayId"
      WHERE o."givenLeftoverId" = ANY(
        ARRAY(SELECT "id" FROM "nearMeals" WHERE "leftoverFromDate" IS NOT NULL)
      )
      EXCEPT
      SELECT "planId" FROM "near"
    ), "meals" AS MATERIALIZED (
      SELECT * FROM "nearMeals"
      UNION ALL
      SELECT d."planId", d."date", m."id", m."mealType", m."recipeId", m."servings", m."quantityScale", m."plate", m."source",
        m."wholePieces", m."keptPieces", m."sharedMealId", m."givenLeftoverId", m."leftoverFromDate", m."leftoverFromMealType"
      FROM "MealPlanDay" d JOIN "PlannedMeal" m ON m."dayId" = d."id"
      WHERE d."planId" = ANY(ARRAY(SELECT "planId" FROM "farther"))
    ), "lines" AS MATERIALIZED (
      SELECT ri."recipeId", r."servings",
        json_agg(
          json_build_object(
            'quantity', ri."quantity",
            'unit', ri."unit",
            'ingredient', json_build_object(
              'id', i."id", 'slug', i."slug", 'name', i."name", 'category', i."category",
              'proteinKind', i."proteinKind", 'canonicalUnit', i."canonicalUnit",
              'gramsPerPiece', i."gramsPerPiece", 'density', i."density",
              'caloriesPer100', i."caloriesPer100", 'proteinPer100', i."proteinPer100",
              'fatPer100', i."fatPer100", 'carbsPer100', i."carbsPer100",
              'fiberPer100', i."fiberPer100", 'sugarsPer100', i."sugarsPer100",
              'saltPer100', i."saltPer100", 'saturatedFatPer100', i."saturatedFatPer100"
            )
          )
          ORDER BY ri."position"
        ) AS "lines"
      FROM "Ingredient" i
      JOIN "RecipeIngredient" ri ON ri."ingredientId" = i."id"
      JOIN "Recipe" r ON r."id" = ri."recipeId"
      WHERE i."slug" = ANY(${[...WHOLE_PIECE_SLUGS]}::text[])
        AND ri."recipeId" = ANY(ARRAY(SELECT DISTINCT "recipeId" FROM "meals" WHERE "recipeId" IS NOT NULL))
      GROUP BY ri."recipeId", r."servings"
    )
    SELECT m."planId", p."options", m."date", m."id", m."mealType", m."recipeId", m."servings",
      m."quantityScale", m."plate", m."source"::text AS "source", m."wholePieces", m."keptPieces", m."sharedMealId",
      s."apart", m."givenLeftoverId", m."leftoverFromDate", m."leftoverFromMealType",
      l."servings" AS "recipeServings", l."lines"
    FROM "meals" m
    JOIN "MealPlan" p ON p."id" = m."planId"
    LEFT JOIN "SharedMeal" s ON s."id" = m."sharedMealId"
    LEFT JOIN "lines" l ON l."recipeId" = m."recipeId"
    ORDER BY m."planId", m."date"`;
  const plans = new Map<
    string,
    { options: unknown; days: Map<string, { date: Date; meals: PotMeal[] }> }
  >();
  for (const row of rows) {
    const plan = plans.get(row.planId) ?? { options: row.options, days: new Map() };
    plans.set(row.planId, plan);
    const key = row.date.toISOString();
    const day = plan.days.get(key) ?? { date: row.date, meals: [] };
    plan.days.set(key, day);
    day.meals.push({
      ...row,
      recipe:
        row.recipeServings === null
          ? null
          : { servings: row.recipeServings, ingredients: row.lines ?? [] },
    });
  }
  return usesOfPlans(
    [...plans.values()].map((plan) => ({ options: plan.options, days: [...plan.days.values()] })),
    mealIds,
    scales,
  );
}

/** A planned meal of `pieceUsesOf`'s read, with its recipe's servings and lines of what is used whole. */
interface PotRow extends Omit<PotMeal, 'recipe'> {
  planId: string;
  options: unknown;
  date: Date;
  recipeServings: number | null;
  lines: Prisma.RecipeIngredientGetPayload<typeof WHOLE_LINES>[] | null;
}

/**
 * A plan whose pots are all of it: no dish of it is shared with another plan, and no leftover of it
 * went to another plan or came from one. Its uses (`usesOfPlans`) need nothing read beside it.
 */
export function selfContained(plan: PotPlan): boolean {
  const meals = plan.days.flatMap((day) => day.meals);
  const ids = new Set(meals.map((meal) => meal.id));
  const given = new Set(
    meals.flatMap((meal) => (meal.givenLeftoverId ? [meal.givenLeftoverId] : [])),
  );
  return meals.every(
    (meal) =>
      meal.sharedMealId === null &&
      (meal.givenLeftoverId === null || ids.has(meal.givenLeftoverId)) &&
      (meal.leftoverFromDate === null || given.has(meal.id)),
  );
}

/**
 * What the meals named take whole of the plans given, each with its pot's factor. A pot is a meal
 * cooked on its own, a dish both people of a joint plan eat (but where each portion is cooked
 * apart), a leftover with the meal it was left of, and a dish cooked once for more meals of a plan
 * made for cooking ahead. A meal that was eaten takes what it was eaten with (`keptPiecesOf`), and
 * the rest of its pot what is left. A meal that takes none is left out of the answer, and so is every
 * meal of a pot that keeps what it was planned with (one of its meals was eaten before pieces were
 * taken whole). `scales` gives meals another `quantityScale`, none at all for a meal that goes: what
 * a change would make of the pots, before it is written.
 */
export function usesOfPlans(
  plans: readonly PotPlan[],
  mealIds: readonly string[],
  scales: ReadonlyMap<string, number> = new Map(),
): Map<string, PieceUse[]> {
  const uses = new Map<string, PieceUse[]>();
  const meals = plans.flatMap((plan) => plan.days.flatMap((day) => day.meals));
  const links: string[][] = [];
  const bySharing = new Map<string, string[]>();
  for (const meal of meals) {
    if (meal.sharedMealId && !meal.apart)
      bySharing.set(meal.sharedMealId, [...(bySharing.get(meal.sharedMealId) ?? []), meal.id]);
    if (meal.givenLeftoverId) links.push([meal.id, meal.givenLeftoverId]);
  }
  links.push(...bySharing.values());
  for (const plan of plans) {
    if (!PlanOptions.parse(plan.options).mealPrepFriendly) continue;
    for (const places of cookingsOf(plan.days).cookings)
      links.push(places.map((place) => place.meal.id));
  }

  const byId = new Map(meals.map((meal) => [meal.id, meal]));
  const takes: PotTake[][] = [];
  const exactOf = new Map<string, Map<string, Exact>>();
  for (const pot of linkedPots(
    meals.map((meal) => meal.id),
    links,
  )) {
    const members = pot.map((id) => byId.get(id)!);
    // A meal eaten before pieces were taken whole keeps its pot as it was planned.
    if (members.some((meal) => !meal.wholePieces)) continue;
    const potTakes: PotTake[] = [];
    for (const meal of members) {
      if (meal.source === 'USER_CUSTOM' || !meal.recipe) continue;
      const scale = scales.get(meal.id) ?? meal.quantityScale;
      const exact = exactPieces(meal.recipe, meal.servings * scale, meal.plate);
      if (exact.size === 0) continue;
      exactOf.set(meal.id, exact);
      const kept = keptPiecesOf(meal.keptPieces);
      for (const [ingredient, { pieces }] of exact)
        potTakes.push(
          kept
            ? { meal: meal.id, ingredient, pieces, kept: kept.get(ingredient) ?? 1 }
            : { meal: meal.id, ingredient, pieces },
        );
    }
    if (potTakes.length) takes.push(potTakes);
  }

  const factors = wholePieceFactors(takes);
  for (const mealId of new Set(mealIds)) {
    const exact = exactOf.get(mealId);
    if (exact) uses.set(mealId, usesOf(exact, factors.get(mealId)));
  }
  return uses;
}

/** What a meal kept of what it took whole when it was eaten: its pot's factor on each ingredient, by id. */
const KeptPieces = z.record(z.string(), z.number().positive());

/** What a meal that was eaten took whole then, by ingredient; null for one that keeps nothing. */
function keptPiecesOf(stored: unknown): Map<string, number> | null {
  if (stored === null || stored === undefined) return null;
  const read = KeptPieces.safeParse(stored);
  return read.success ? new Map(Object.entries(read.data)) : null;
}

/**
 * Keep on each of the meals named that is eaten what its pot makes it take whole now, worked out as if it
 * had kept nothing, and keep nothing on each that is not eaten. For a write that marks a meal eaten or not,
 * or that changes the portion of one that is eaten, once the meals of its pot are written and before any
 * day is sized again, so that what is kept is what the person saw.
 */
export async function keepPieces(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | 'plannedMeal'>,
  mealIds: readonly string[],
): Promise<void> {
  if (mealIds.length === 0) return;
  const ids = [...new Set(mealIds)];
  await tx.plannedMeal.updateMany({
    where: { id: { in: ids } },
    data: { keptPieces: Prisma.DbNull },
  });
  const eaten = await tx.plannedMeal.findMany({
    where: { id: { in: ids }, eatenAt: { not: null } },
    select: { id: true },
  });
  if (eaten.length === 0) return;
  const uses = await pieceUsesOf(
    tx,
    eaten.map((meal) => meal.id),
  );
  for (const [mealId, taken] of uses)
    await tx.plannedMeal.update({
      where: { id: mealId },
      data: {
        keptPieces: Object.fromEntries(taken.map((use) => [use.ingredientId, use.factor])),
      },
    });
}

type WholeIngredient = Prisma.RecipeIngredientGetPayload<typeof WHOLE_LINES>['ingredient'];

/** A recipe with its lines: those of what is used whole are read (`WHOLE_LINES`), the rest passed over. */
interface WholeRecipe {
  servings: number;
  ingredients: readonly Prisma.RecipeIngredientGetPayload<typeof WHOLE_LINES>[];
}

/** What a meal takes exactly of an ingredient used whole: in its canonical unit, in pieces, and the ingredient. */
interface Exact {
  amount: number;
  pieces: number;
  ingredient: WholeIngredient;
}

/**
 * What `servings` of a recipe take exactly of each ingredient used whole, each line at its part of
 * a person's `plate` (`plateOfMeal`), lines of one ingredient summed.
 */
function exactPieces(recipe: WholeRecipe, servings: number, plate: unknown): Map<string, Exact> {
  const ofRecipe = servings / Math.max(1, recipe.servings);
  const onPlate = plateOfMeal(plate);
  const exact = new Map<string, Exact>();
  for (const line of recipe.ingredients) {
    if (!line.ingredient.slug || !WHOLE_PIECE_SLUGS.includes(line.ingredient.slug)) continue;
    const quantity = line.quantity * ofRecipe * plateShare(onPlate, line.ingredient);
    const amount = inUnit(quantity, line.unit, line.ingredient.canonicalUnit, line.ingredient);
    const pieces = inUnit(quantity, line.unit, 'piece', line.ingredient);
    if (amount === null || pieces === null || pieces <= 0) continue;
    const held = exact.get(line.ingredient.id);
    exact.set(line.ingredient.id, {
      amount: (held?.amount ?? 0) + amount,
      pieces: (held?.pieces ?? 0) + pieces,
      ingredient: line.ingredient,
    });
  }
  return exact;
}

/** A meal's uses of what it takes whole, at its pot's factors (1 where none is given). */
function usesOf(
  exact: ReadonlyMap<string, Exact>,
  factors?: ReadonlyMap<string, number>,
): PieceUse[] {
  return [...exact.entries()].map(([ingredientId, { amount, ingredient }]) => ({
    ingredientId,
    exact: amount,
    factor: factors?.get(ingredientId) ?? 1,
    per100: {
      calories: ingredient.caloriesPer100,
      protein: ingredient.proteinPer100,
      fat: ingredient.fatPer100,
      carbs: ingredient.carbsPer100,
    },
    label: {
      fiber: ingredient.fiberPer100,
      sugars: ingredient.sugarsPer100,
      salt: ingredient.saltPer100,
      saturatedFat: ingredient.saturatedFatPer100,
    },
  }));
}

/**
 * What a meal would take whole with the lines of `recipe`: `servings` of it, each line at its part of the
 * meal's `plate`. An ingredient it would take as much of as it takes now (`now`, its uses of
 * `pieceUsesOf`) keeps its pot's factor; one it would take another amount of, or newly, is rounded in the
 * meal alone. With nothing taken now and no plate it is a dish not planned yet, cooked on its own as it
 * would be once planned. For a figure shown before a meal is made or changed (a way of a day, a swap's
 * preview), so that it is what the meal will hold.
 */
export function piecesOfOffer(
  recipe: WholeRecipe,
  servings: number,
  meal: { now?: readonly PieceUse[]; plate?: unknown } = {},
): PieceUse[] {
  const exact = exactPieces(recipe, servings, meal.plate ?? null);
  const alone = wholePieceFactors([
    [...exact.entries()].map(([ingredient, { pieces }]) => ({ meal: 'offer', ingredient, pieces })),
  ]).get('offer');
  const factors = new Map(
    [...exact.entries()].map(([ingredientId, { amount }]) => {
      const was = meal.now?.find((use) => use.ingredientId === ingredientId);
      const same = was !== undefined && Math.abs(was.exact - amount) <= 1e-6 * Math.max(1, amount);
      return [ingredientId, same ? was.factor : (alone?.get(ingredientId) ?? 1)];
    }),
  );
  return usesOf(exact, factors);
}

/** The factor of a meal's line of an ingredient, from what the meal takes whole: 1 for the rest. */
export function pieceFactorOf(uses: readonly PieceUse[], ingredientId: string): number {
  return uses.find((use) => use.ingredientId === ingredientId)?.factor ?? 1;
}

/** What the meals of a reader take whole, by meal (`pieceUsesOf`). */
export type PieceUses = ReadonlyMap<string, readonly PieceUse[]>;

/** A meal with what it takes whole beside it: none where it takes none. */
export function pieced<M extends { id: string }>(
  meal: M,
  uses: PieceUses,
): M & { pieces: readonly PieceUse[] } {
  return { ...meal, pieces: uses.get(meal.id) ?? [] };
}

/** A meal as its servings hold it, its pot's eggs and tortillas not rounded: for fitting a day, which rounds after. */
export function exactly<M extends { id: string }>(meal: M): M & { pieces: readonly PieceUse[] } {
  return { ...meal, pieces: [] };
}

/** Days whose meals have what they take whole beside them. */
export function piecedDays<D extends { meals: readonly { id: string }[] }>(
  days: readonly D[],
  uses: PieceUses,
): (Omit<D, 'meals'> & { meals: (D['meals'][number] & { pieces: readonly PieceUse[] })[] })[] {
  return days.map((day) => ({
    ...day,
    meals: day.meals.map((meal: D['meals'][number]) => pieced(meal, uses)),
  }));
}
