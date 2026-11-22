// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** What a day of a plan and its meals carry of their own, as it is kept with them and read back. */
import {
  KCAL_PER_GRAM,
  LabelTotals,
  Unit,
  type DietType,
  type Macros,
  type MacrosOffCause,
  type MacrosOffWhy,
  type MealType,
} from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { storedProteinGrams, storedSplit } from '../common/stored-split.js';
import {
  aimOnDiet,
  dayMacros,
  distanceOnDiet,
  energyShares,
  MACROS_OFF,
  macrosForCalories,
  macroSplitOf,
  ownSplit,
  sharesOf,
} from '../engine/nutrition.js';
import {
  labelOfAmount,
  roundLabel,
  scaleLabel,
  storedTotals,
  sumLabels,
  UNKNOWN_LABEL,
} from '../engine/label-totals.js';
import {
  partOf,
  plateChange,
  shareOnPlate,
  type PartIngredient,
  type Plate,
  type PlateDish,
} from '../engine/plates.js';
import { REBALANCE_TOLERANCE } from '../engine/rebalance.js';
import type { PieceUse } from '../engine/whole-pieces.js';

/**
 * Persisted per-day overrides. The resolved per-day calorie target lives in
 * the `MealPlanDay.calorieTarget` column (so swap, favorite-set apply and the
 * rebalancer read it unchanged); this JSON carries the raw advanced inputs + semantics needed to
 * re-roll the day and to render it. `calorieTarget` is stored here only when it
 * was an explicit override, so `regenerate` can pick up profile changes for
 * non-overridden days while preserving deliberate per-day targets.
 */
export type DayOverridesJson = {
  mealCount?: number;
  calorieTarget?: number;
  dayType?: 'normal' | 'rest' | 'training';
  skip?: boolean;
  cookTimeBudgetMinutes?: number;
  useUpBy?: boolean;
  lockedSlots?: { mealType: MealType; recipeId: string }[];
};

/** Narrow a Prisma JSON column to the day-overrides shape (null when absent). */
export function parseDayOverrides(raw: unknown): DayOverridesJson | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as DayOverridesJson;
  }
  return null;
}

/** The date of a day, as the API writes dates. */
const MEAL_RANK: Record<string, number> = {
  breakfast: 0,
  second_breakfast: 1,
  lunch: 2,
  snack: 3,
  dinner: 4,
};

/** Where a time of day comes in a day: breakfast first, dinner last. */
export function mealRank(slot: string): number {
  return MEAL_RANK[slot] ?? 99;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Of the plans of a profile that hold a day, the one made last: as the calendar and the diary pick it. */
export const MADE_LAST = [{ plan: { createdAt: 'desc' } }, { planId: 'asc' }] as const;

/**
 * The rest of a pack a meal finishes, in a plan that wastes less, as the meal
 * keeps it (`PlannedMeal.rests`): the ingredient, one of its recipe's, the
 * amount of this meal's portion in the ingredient's own unit, and what that
 * holds, as it was when the rest was put in.
 */
export const StoredRest = z.object({
  ingredientId: z.string().uuid(),
  amount: z.number().positive(),
  /** The ingredient's own unit, which the amount is in. */
  unit: Unit,
  figures: z.object({
    calories: z.number().min(0),
    protein: z.number().min(0),
    fat: z.number().min(0),
    carbs: z.number().min(0),
  }),
  label: LabelTotals,
});
export type StoredRest = z.infer<typeof StoredRest>;

/**
 * A person's own plate of a dish both people of a joint plan eat (cooking
 * together), as the meal keeps it (`PlannedMeal.plate`): how much of each part
 * that may move its portion holds against the recipe's proportion
 * (`engine/plates.ts`), and what that changes of one serving at a scale of
 * one, the plate's figures and label less the recipe's, so that they follow the
 * portion's size.
 */
export const StoredPlate = z.object({
  protein: z.number().min(0.5).max(1.5),
  starch: z.number().min(0.5).max(1.5),
  vegetables: z.number().min(1).max(1.5),
  perServing: z.object({
    calories: z.number(),
    protein: z.number(),
    fat: z.number(),
    carbs: z.number(),
  }),
  labelPerServing: z.object({
    fiber: z.number(),
    sugars: z.number(),
    salt: z.number(),
    saturatedFat: z.number(),
  }),
});
export type StoredPlate = z.infer<typeof StoredPlate>;

/** How much of a line of a meal its plate holds against the recipe's proportion: its part's share, one for the rest. */
export function plateShare(
  plate: StoredPlate | null,
  ingredient: Pick<PartIngredient, 'name'> & {
    slug?: string | null;
    category?: string | null;
    proteinKind?: string | null;
  },
): number {
  if (!plate) return 1;
  const part = partOf({
    slug: ingredient.slug ?? null,
    name: ingredient.name,
    category: ingredient.category ?? null,
    proteinKind: ingredient.proteinKind ?? null,
  });
  return part === 'rest' ? 1 : plate[part];
}

/** A person's plate of a dish as the meal keeps it: its shares, and what they change of a serving, to a tenth and a hundredth of a gram. */
export function storedPlateOf(dish: PlateDish, plate: Plate): StoredPlate {
  const { perServing, labelPerServing } = plateChange(dish, plate);
  const tenth = (value: number): number => Math.round(value * 10) / 10 || 0;
  const hundredth = (value: number): number => Math.round(value * 100) / 100 || 0;
  return {
    protein: plate.protein,
    starch: plate.starch,
    vegetables: plate.vegetables,
    perServing: {
      calories: tenth(perServing.calories),
      protein: tenth(perServing.protein),
      fat: tenth(perServing.fat),
      carbs: tenth(perServing.carbs),
    },
    labelPerServing: {
      fiber: hundredth(labelPerServing.fiber),
      sugars: hundredth(labelPerServing.sugars),
      salt: hundredth(labelPerServing.salt),
      saturatedFat: hundredth(labelPerServing.saturatedFat),
    },
  };
}

/** How much of each ingredient of a dish (by its id) a plate holds against the recipe's proportion. */
export function plateSharesOf(dish: PlateDish, plate: Plate): Map<string, number> {
  return new Map(
    [...dish.partOf].map(([ingredientId, part]) => [ingredientId, shareOnPlate(plate, part)]),
  );
}

/** The plate a meal keeps: none where it keeps none, or none in this shape. */
export function plateOfMeal(stored: unknown): StoredPlate | null {
  const parsed = StoredPlate.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** A plate as a meal's row keeps it: none is no value at all. */
export const plateAsJson = (
  plate: StoredPlate | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  plate ? (plate as unknown as Prisma.InputJsonValue) : Prisma.DbNull;

/** The rests a meal keeps: none where it keeps none, or none in this shape. */
export function restsOf(stored: unknown): StoredRest[] {
  const parsed = z.array(StoredRest).safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** A rest as a meal keeps it: its amount and what that holds, to a tenth; null for one too small to keep. */
export function storedRestOf(
  food: {
    canonicalUnit: Unit;
    caloriesPer100: number;
    proteinPer100: number;
    fatPer100: number;
    carbsPer100: number;
    fiberPer100: number | null;
    sugarsPer100: number | null;
    saltPer100: number | null;
    saturatedFatPer100: number | null;
  },
  rest: { ingredientId: string; amount: number },
): StoredRest | null {
  const tenth = (value: number): number => Math.round(value * 10) / 10;
  const amount = tenth(rest.amount);
  if (amount <= 0) return null;
  return {
    ingredientId: rest.ingredientId,
    amount,
    unit: food.canonicalUnit,
    figures: {
      calories: tenth((food.caloriesPer100 * amount) / 100),
      protein: tenth((food.proteinPer100 * amount) / 100),
      fat: tenth((food.fatPer100 * amount) / 100),
      carbs: tenth((food.carbsPer100 * amount) / 100),
    },
    label: roundLabel(labelOfAmount(food, amount)),
  };
}

/** Rests as a meal's row keeps them: none is no value. */
export const restsAsJson = (
  rests: readonly StoredRest[],
): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  rests.length > 0 ? (rests as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;

/**
 * After meals were given another recipe: each keeps the rests of packs whose
 * ingredient its new recipe holds as well, and loses the others, and loses its
 * plate, which was of the dish before. Run in the write that changed the
 * recipes.
 */
export async function settleNewRecipes(
  tx: Pick<Prisma.TransactionClient, 'plannedMeal'>,
  mealIds: readonly string[],
): Promise<void> {
  if (mealIds.length === 0) return;
  await tx.plannedMeal.updateMany({
    where: { id: { in: [...mealIds] }, plate: { not: Prisma.DbNull } },
    data: { plate: Prisma.DbNull },
  });
  const meals = await tx.plannedMeal.findMany({
    where: { id: { in: [...mealIds] }, rests: { not: Prisma.DbNull } },
    select: {
      id: true,
      rests: true,
      recipe: { select: { ingredients: { select: { ingredientId: true } } } },
    },
  });
  for (const meal of meals) {
    const held = new Set(meal.recipe?.ingredients.map((line) => line.ingredientId) ?? []);
    const rests = restsOf(meal.rests);
    const kept = rests.filter((rest) => held.has(rest.ingredientId));
    if (kept.length !== rests.length)
      await tx.plannedMeal.update({ where: { id: meal.id }, data: { rests: restsAsJson(kept) } });
  }
}

/** The rests of a meal of which a share goes elsewhere, or stays: each amount and what it holds in that share, to a tenth. */
export function scaleRests(stored: unknown, share: number): StoredRest[] {
  const tenth = (value: number): number => Math.round(value * share * 10) / 10;
  return restsOf(stored).flatMap((rest) => {
    const amount = tenth(rest.amount);
    return amount > 0
      ? [
          {
            ...rest,
            amount,
            figures: {
              calories: tenth(rest.figures.calories),
              protein: tenth(rest.figures.protein),
              fat: tenth(rest.figures.fat),
              carbs: tenth(rest.figures.carbs),
            },
            label: roundLabel(scaleLabel(rest.label, share)),
          },
        ]
      : [];
  });
}

/** As much of a planned meal as says what it amounts to. */
export interface MealAmount {
  servings: number;
  quantityScale: number;
  /** The rests of packs it finishes (`restsOf`), counted beside its recipe. */
  rests: unknown;
  /** A person's own plate of a shared dish (`plateOfMeal`), which changes what a serving holds. */
  plate: unknown;
  /** What it takes of eggs and tortillas, which its pot takes whole (`pieceUsesOf`). */
  pieces: readonly PieceUse[];
  source: string;
  customMacros: unknown;
  recipe: {
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
  } | null;
}

/** A planned meal as a read of it holds it, before what it takes whole is put beside it (`pieced`). */
export type MealRow = Omit<MealAmount, 'pieces'>;

interface Amounts {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/**
 * What a planned meal amounts to: one serving of its recipe, or the macros
 * somebody typed for a meal of their own, times its servings and the factor
 * a rebalance left on it, and what its pot's whole eggs and tortillas add to
 * or take from that.
 */
export function mealNutrition(meal: MealAmount): Amounts {
  const factor = meal.servings * meal.quantityScale;
  const per =
    meal.source === 'USER_CUSTOM' || !meal.recipe
      ? customMacros(meal.customMacros)
      : {
          calories: meal.recipe.caloriesPerServing,
          protein: meal.recipe.proteinPerServing,
          fat: meal.recipe.fatPerServing,
          carbs: meal.recipe.carbsPerServing,
        };
  const rests = restsOf(meal.rests);
  const plate = meal.source === 'USER_CUSTOM' ? null : plateOfMeal(meal.plate);
  const plus = (of: keyof Amounts): number =>
    rests.reduce((sum, rest) => sum + rest.figures[of], 0) +
    (plate ? plate.perServing[of] * factor : 0) +
    wholeAddition(meal.pieces, of);
  return {
    calories: Math.round(per.calories * factor + plus('calories')),
    protein: Math.round(per.protein * factor + plus('protein')),
    fat: Math.round(per.fat * factor + plus('fat')),
    carbs: Math.round(per.carbs * factor + plus('carbs')),
  };
}

/** What a meal's pots taking its eggs and tortillas whole add to a figure of it, against what it takes exactly: less where a pot rounds down. */
export function wholeAddition(uses: readonly PieceUse[], of: keyof Amounts): number {
  return uses.reduce((sum, use) => sum + (use.factor - 1) * (use.exact / 100) * use.per100[of], 0);
}

/** As much of a planned meal as says what it holds of fibre, sugars, salt and saturated fat. */
export interface MealLabelAmount {
  servings: number;
  quantityScale: number;
  /** The rests of packs it finishes (`restsOf`), counted beside its recipe. */
  rests: unknown;
  /** A person's own plate of a shared dish (`plateOfMeal`), which changes what a serving holds. */
  plate: unknown;
  /** What it takes of eggs and tortillas, which its pot takes whole (`pieceUsesOf`). */
  pieces: readonly PieceUse[];
  source: string;
  recipe: { labelPerServing: unknown } | null;
}

/**
 * What a planned meal holds of fibre, sugars, salt and saturated fat: a serving of its recipe
 * times its servings and the factor a rebalance left on it, to a tenth of a gram. Nothing of them
 * is known of a meal of one's own, nor of a recipe they were not worked out for yet.
 */
export function mealLabel(meal: MealLabelAmount): LabelTotals {
  if (meal.source === 'USER_CUSTOM' || !meal.recipe) return UNKNOWN_LABEL;
  const serving = storedTotals(meal.recipe.labelPerServing);
  if (!serving) return UNKNOWN_LABEL;
  const factor = meal.servings * meal.quantityScale;
  const plate = plateOfMeal(meal.plate);
  const dish = piecesLabel(
    scaleLabel(plate ? plateLabel(serving, plate) : serving, factor),
    meal.pieces,
  );
  const rests = restsOf(meal.rests);
  return roundLabel(
    rests.length > 0 ? sumLabels([dish, ...rests.map((rest) => rest.label)]) : dish,
  );
}

/** A dish's label with what its pot's whole eggs and tortillas add or take: each known figure moved, never under none. */
function piecesLabel(dish: LabelTotals, uses: readonly PieceUse[]): LabelTotals {
  if (uses.length === 0) return dish;
  const by = (nutrient: keyof PieceUse['label']): number =>
    uses.reduce(
      (sum, use) => sum + (use.factor - 1) * (use.exact / 100) * (use.label[nutrient] ?? 0),
      0,
    );
  const moved = (figure: LabelTotals[keyof LabelTotals], change: number) =>
    figure ? { ...figure, grams: Math.max(0, figure.grams + change) } : figure;
  return {
    fiber: moved(dish.fiber, by('fiber')),
    sugars: moved(dish.sugars, by('sugars')),
    salt: moved(dish.salt, by('salt')),
    saturatedFat: moved(dish.saturatedFat, by('saturatedFat')),
  };
}

/** A serving's label with a plate's change: each known figure moved by the plate's grams, never under none. */
function plateLabel(serving: LabelTotals, plate: StoredPlate): LabelTotals {
  const moved = (figure: LabelTotals[keyof LabelTotals], by: number) =>
    figure ? { ...figure, grams: Math.max(0, figure.grams + by) } : figure;
  return {
    fiber: moved(serving.fiber, plate.labelPerServing.fiber),
    sugars: moved(serving.sugars, plate.labelPerServing.sugars),
    salt: moved(serving.salt, plate.labelPerServing.salt),
    saturatedFat: moved(serving.saturatedFat, plate.labelPerServing.saturatedFat),
  };
}

export function sumNutrition(items: Amounts[]): Amounts {
  return items.reduce(
    (acc, n) => ({
      calories: acc.calories + n.calories,
      protein: acc.protein + n.protein,
      fat: acc.fat + n.fat,
      carbs: acc.carbs + n.carbs,
    }),
    {
      calories: 0,
      protein: 0,
      fat: 0,
      carbs: 0,
    },
  );
}

/**
 * What a day of a plan aims at of protein, fat and carbohydrate, in grams: the
 * protein of the plan's target, whatever the kind of day, and its own
 * calories in carbohydrate and fat (`dayMacros`).
 */
export const aimOfDay = (
  day: { calorieTarget: number; overrides: unknown },
  plan: { dietType: string; macroSplit: unknown; calorieTarget: number },
): Macros =>
  // A plan of the custom diet's protein per kilogram keeps its grams of protein on every day, whatever its kind
  // or its own target; fat takes its share of the day's calories and carbohydrate the rest.
  storedProteinGrams(plan.macroSplit) !== null
    ? macrosForCalories(day.calorieTarget, 'custom', sharesOfPlanDay(plan, day.calorieTarget))
    : dayMacros(
        {
          target: day.calorieTarget,
          base: plan.calorieTarget,
          ownTarget: parseDayOverrides(day.overrides)?.calorieTarget ?? null,
        },
        plan.dietType as DietType,
        sharesOf(storedSplit(plan.macroSplit)),
      );

/**
 * The shares of its energy a day of `calories` of a plan aims at: its diet's
 * split, or on the custom diet its own; for a plan made by protein per
 * kilogram, protein the energy of the grams it keeps, fat its share and
 * carbohydrate the rest, held inside the limits of a split (`ownSplit`).
 */
export function sharesOfPlanDay(
  plan: { dietType: string; macroSplit: unknown },
  calories: number,
): Macros {
  const own = sharesOf(storedSplit(plan.macroSplit));
  const grams = storedProteinGrams(plan.macroSplit);
  return plan.dietType === 'custom' && own && grams !== null
    ? ownSplit(own, grams * KCAL_PER_GRAM.protein, calories).shares
    : macroSplitOf(plan.dietType as DietType, own);
}

/** A day the user skips is no day of eating and no shortfall, whatever was eaten of it before it was skipped. */
export function isSkipped(day: { overrides: unknown }): boolean {
  return parseDayOverrides(day.overrides)?.skip === true;
}

/**
 * How many meals a day is set for: its own number, the plan's, or else as
 * many as it has from the catalogue (two to five), and the profile's for a day
 * that has none. A day made again, and a change of its settings, start from
 * this.
 */
export function dayMealCount(
  day: { overrides: unknown; meals: { source: string }[] },
  planCount: number | null,
  profileCount: number,
): number {
  const own = parseDayOverrides(day.overrides)?.mealCount;
  if (own !== undefined) return own;
  if (planCount !== null) return planCount;
  const fromCatalogue = day.meals.filter((meal) => meal.source === 'CATALOGUE').length;
  return fromCatalogue > 0 ? Math.min(5, Math.max(2, fromCatalogue)) : profileCount;
}

/**
 * Where a day stands against its target: how far over or under it is, and
 * whether that is outside the window a rebalance brings a day back into. A
 * skipped day is neither over nor under.
 */
export function standingOf(
  calories: number,
  target: number,
  skipped: boolean,
): { calorieDelta: number; offTarget: 'over' | 'under' | null } {
  const calorieDelta = skipped ? 0 : calories - target;
  return {
    calorieDelta,
    offTarget:
      Math.abs(calorieDelta) <= REBALANCE_TOLERANCE * target
        ? null
        : calorieDelta > 0
          ? 'over'
          : 'under',
  };
}

/**
 * What a day of a plan holds of protein, fat and carbohydrate is far from what
 * it aims at: `aim`, the grams of a day (`aimOfDay`), or else the plan's split,
 * as the plan's diet measures it (`distanceOnDiet`).
 */
export function macrosOff(
  held: Macros,
  plan: { dietType: string; macroSplit: unknown; calorieTarget?: number },
  aim?: Macros,
): boolean {
  const shares = energyShares(held);
  // Without a target, a plan of protein per kilogram is measured against its split as it was made.
  const split = (aim && energyShares(aim)) ?? sharesOfPlanDay(plan, plan.calorieTarget ?? 0);
  return shares !== null && distanceOnDiet(shares, split, plan.dietType) > MACROS_OFF;
}

/** A meal of a day as the causes of its macros read it (`whyMacrosOff`). */
export interface MealOfDay {
  nutrition: Amounts;
  /** The plan leaves it as it is: eaten, a meal of one's own, a leftover. */
  fixed: boolean;
  /** Chosen by hand: swapped, or a dish off the plan's diet. */
  byHand: boolean;
}

/** Of what the plan does not change, at least this share of the day's energy says the day was held to it. */
const FIXED_SHARE = 0.25;
/** A share of energy past which a macronutrient is too much or too little of what the day aims at. */
const LEANS = 0.02;

/**
 * Why a day's macros are off (`MacrosOffWhy`): what it holds too much and too little of against the split as its diet
 * measures it (`aimOnDiet`), and what makes it so: what the plan does not change, where it holds a quarter of the day
 * or more and is far from the split itself; the day's settings; meals chosen by hand; times of day a single dish fit
 * when the plan was made; and, where nothing of these, the diet's dishes themselves.
 */
export function whyMacrosOff(day: {
  /** What the day holds, its diary and other plans' eaten meals included. */
  held: Amounts;
  /** The shares of energy the day aims at. */
  aim: Macros;
  dietType: string;
  meals: readonly MealOfDay[];
  /** What the diary holds of the day and other plans' meals eaten on it. */
  besides: Amounts | null;
  overrides: { mealCount?: number; cookTimeBudgetMinutes?: number; useUpBy?: boolean } | null;
  /** How many meals the plan's days have where a day says nothing of its own. */
  usualMeals: number;
  /** The times of day of the day that a single dish fit when the plan was made, the dish still there. */
  single: readonly MealType[];
}): MacrosOffWhy {
  const shares = energyShares(day.held) ?? day.aim;
  const against = aimOnDiet(shares, day.aim, day.dietType);
  const leans = (['protein', 'fat', 'carbs'] as const).map(
    (part) => [part, shares[part] - against[part]] as const,
  );
  const most = leans.reduce((a, b) => (b[1] > a[1] ? b : a));
  const least = leans.reduce((a, b) => (b[1] < a[1] ? b : a));
  const causes: MacrosOffCause[] = [];
  const fixed = sumNutrition([
    ...day.meals.filter((meal) => meal.fixed).map((meal) => meal.nutrition),
    ...(day.besides ? [day.besides] : []),
  ]);
  const energy = (of: Macros) =>
    of.protein * KCAL_PER_GRAM.protein +
    of.fat * KCAL_PER_GRAM.fat +
    of.carbs * KCAL_PER_GRAM.carbs;
  const share = energy(day.held) > 0 ? energy(fixed) / energy(day.held) : 0;
  const fixedShares = energyShares(fixed);
  if (
    share >= FIXED_SHARE &&
    fixedShares &&
    distanceOnDiet(fixedShares, day.aim, day.dietType) > MACROS_OFF
  )
    causes.push({ kind: 'fixed', share: Math.min(100, Math.round(share * 100)) });
  const own = day.overrides;
  if (own?.cookTimeBudgetMinutes !== undefined)
    causes.push({ kind: 'cookTime', minutes: own.cookTimeBudgetMinutes });
  if (own?.mealCount !== undefined && own.mealCount < day.usualMeals)
    causes.push({ kind: 'fewerMeals', count: own.mealCount });
  if (own?.useUpBy === true) causes.push({ kind: 'useUp' });
  const byHand = day.meals.filter((meal) => !meal.fixed && meal.byHand).length;
  if (byHand > 0) causes.push({ kind: 'byHand', count: byHand });
  if (day.single.length > 0) causes.push({ kind: 'singleDish', slots: [...day.single] });
  if (causes.length === 0) causes.push({ kind: 'diet' });
  return {
    over: most[1] > LEANS ? most[0] : null,
    under: least[1] < -LEANS ? least[0] : null,
    causes,
  };
}

/**
 * What a day of a plan holds as it stands, as the plan shows the day: its meals, the toppings eaten with them, and
 * what the diary holds of the day, which a day resized around the diary needs to stand at its target.
 */
export function dayAsItStands(
  meals: readonly MealAmount[],
  toppings: readonly Amounts[],
  diary: Amounts | null,
): Amounts {
  return sumNutrition([...meals.map(mealNutrition), ...toppings, ...(diary ? [diary] : [])]);
}

/**
 * What a day of a plan holds on average, each day as it stands (`dayAsItStands`), over the days that are not
 * skipped: the average a plan's days are measured by, so that a day resized around its diary is no shortfall.
 */
export function averageDay(days: readonly { skipped: boolean; nutrition: Amounts }[]): Amounts {
  const eaten = days.filter((day) => !day.skipped);
  if (eaten.length === 0) return { calories: 0, protein: 0, fat: 0, carbs: 0 };
  const total = sumNutrition(eaten.map((day) => day.nutrition));
  return {
    calories: Math.round(total.calories / eaten.length),
    protein: Math.round(total.protein / eaten.length),
    fat: Math.round(total.fat / eaten.length),
    carbs: Math.round(total.carbs / eaten.length),
  };
}

/** Read frozen, user-entered macros off a custom meal row (defaults to zero). */
export function customMacros(raw: unknown): {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
} {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    calories: num(o.calories),
    protein: num(o.protein),
    fat: num(o.fat),
    carbs: num(o.carbs),
  };
}
