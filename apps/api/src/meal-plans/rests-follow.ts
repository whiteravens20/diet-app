// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PlanOptions, type MealType } from '@diet-app/shared';
import { potsOf } from '../engine/close-packs.js';
import { packRests, type RestInput, type RestPlan } from '../engine/pack-rests.js';
import type { Pack } from '../engine/packs.js';
import { toCanonical, UnitConversionError } from '../engine/units.js';
import { levelOf, type WasteLevel } from '../engine/waste-levels.js';
import { WHOLE_PIECE_SLUGS } from '../engine/whole-pieces.js';
import {
  customMacros,
  isoDate,
  plateOfMeal,
  plateShare,
  restsAsJson,
  restsOf,
  storedRestOf,
  type StoredRest,
} from './plan-days.js';
import { diaryOfDays, type DiaryOnDay } from '../diary/diary-days.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { cookedDaysOf } from './plan-menu.js';
import { toppingFoodsOf } from './toppings-store.js';

type Tx = Prisma.TransactionClient;

/** What an ingredient of a meal's recipe is read with: its pack, how it converts, what it holds. */
const INGREDIENT = {
  select: {
    id: true,
    slug: true,
    name: true,
    category: true,
    proteinKind: true,
    canonicalUnit: true,
    gramsPerPiece: true,
    density: true,
    packSize: true,
    perishable: true,
    keepDays: true,
    caloriesPer100: true,
    proteinPer100: true,
    fatPer100: true,
    carbsPer100: true,
    fiberPer100: true,
    sugarsPer100: true,
    saltPer100: true,
    saturatedFatPer100: true,
  },
} satisfies Prisma.IngredientDefaultArgs;

/** A plan of a kitchen as its rests are worked out from it. */
const KITCHEN_PLAN = {
  id: true,
  profileId: true,
  options: true,
  jointPlanId: true,
  days: {
    orderBy: { date: 'asc' },
    select: {
      date: true,
      calorieTarget: true,
      meals: {
        select: {
          id: true,
          mealType: true,
          recipeId: true,
          servings: true,
          quantityScale: true,
          eatenAt: true,
          source: true,
          leftoverFromDate: true,
          leftoverFromMealType: true,
          customMacros: true,
          rests: true,
          plate: true,
          toppingKey: true,
          toppingAmount: true,
          sharedMealId: true,
          recipe: {
            select: {
              id: true,
              servings: true,
              caloriesPerServing: true,
              ingredients: {
                select: { ingredientId: true, quantity: true, unit: true, ingredient: INGREDIENT },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.MealPlanSelect;

type KitchenPlan = Prisma.MealPlanGetPayload<{ select: typeof KITCHEN_PLAN }>;
type KitchenMeal = KitchenPlan['days'][number]['meals'][number];
/** What a food of a pack is read with: its pack, and what a rest of it holds (`storedRestOf`). */
type PackFood = Pick<
  Prisma.IngredientGetPayload<typeof INGREDIENT>,
  | 'id'
  | 'slug'
  | 'category'
  | 'canonicalUnit'
  | 'packSize'
  | 'perishable'
  | 'keepDays'
  | 'caloriesPer100'
  | 'proteinPer100'
  | 'fatPer100'
  | 'carbsPer100'
  | 'fiberPer100'
  | 'sugarsPer100'
  | 'saltPer100'
  | 'saturatedFatPer100'
>;

/** A meal whose rests the plan writes again: its rests as they are kept and as they come out now. */
export interface FollowedRest {
  planId: string;
  mealId: string;
  before: StoredRest[];
  after: StoredRest[];
}

/** The level a plan counts its packs at: none for a plan made as usual, which has no rests. */
export function wasteLevelOf(options: unknown): WasteLevel | null {
  const parsed = PlanOptions.safeParse(options);
  return parsed.success ? levelOf(parsed.data) : null;
}

/**
 * The rests of packs the meals of a plan that wastes less or nothing finish, worked out again from the plan as it
 * stands, by the rules they were given by when it was made (`packRests`: a rest whole or not at all, small against
 * the dish and the day, the day in its window): a dish that takes less of a pack leaves its meal a greater rest, one
 * that takes more a smaller one or none, and a rest that no longer fits is no rest: the plan's packs say what is left.
 * Worked out on the kitchen, the plan of whoever shares it counted with it; written only to meals still to be eaten,
 * a meal eaten, or of a day gone, keeps what it was eaten with, and what it took is gone from its pack. Eggs and
 * tortillas, which their pots take whole, keep the rests they have. Run last in a write that changed the meals of a
 * plan (`writePlans`). Answers the meals whose rests it wrote.
 */
export async function followRests(
  tx: Tx,
  planId: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<FollowedRest[]> {
  const own = await tx.mealPlan.findUnique({ where: { id: planId }, select: KITCHEN_PLAN });
  if (!own) return [];
  const level = wasteLevelOf(own.options);
  if (!level) return [];
  const partner = own.jointPlanId
    ? await tx.mealPlan.findFirst({
        where: { jointPlanId: own.jointPlanId, id: { not: own.id } },
        select: KITCHEN_PLAN,
      })
    : null;
  const plans = partner ? [own, partner] : [own];
  const toppingFoods: ReadonlyMap<string, PackFood> = plans.some((plan) =>
    plan.days.some((day) => day.meals.some((meal) => meal.toppingKey !== null)),
  )
    ? await toppingFoodsOf(tx)
    : new Map();

  // What the diary of a day holds stays on the day, as the plan was made around it.
  const diaries: ReadonlyMap<string, DiaryOnDay>[] = [];
  for (const plan of plans) diaries.push(await diaryOfDays(tx, plan.profileId, plan.days, plan.id));
  const worked = restsOfKitchen(plans, level, toppingFoods, today, diaries);
  const followed: FollowedRest[] = [];
  for (const plan of plans)
    for (const day of plan.days) {
      // What is eaten, or of a day gone, keeps what it was eaten with.
      if (isoDate(day.date) < today) continue;
      for (const meal of day.meals) {
        if (meal.eatenAt !== null || !worked.has(meal.id)) continue;
        const before = restsOf(meal.rests);
        // What the work leaves alone, a food it counts no packs of, the meal keeps.
        const kept = before.filter((rest) => !worked.counted.has(rest.ingredientId));
        const after = [...kept, ...worked.get(meal.id)!];
        if (sameRests(before, after)) continue;
        await tx.plannedMeal.update({
          where: { id: meal.id },
          data: { rests: restsAsJson(after) },
        });
        followed.push({ planId: plan.id, mealId: meal.id, before, after });
      }
    }
  return followed;
}

/** Two lists of rests that say the same: the same foods in the same amounts, to the tenth, in any order. */
function sameRests(a: readonly StoredRest[], b: readonly StoredRest[]): boolean {
  const key = (rests: readonly StoredRest[]) =>
    rests
      .map((rest) => `${rest.ingredientId}:${Math.round(rest.amount * 10)}`)
      .sort()
      .join('|');
  return key(a) === key(b);
}

/**
 * The rests each meal of the kitchen's plans takes as the plans stand, by meal, of the foods counted in packs
 * (`counted`): every meal of a recipe that cooks is placed as the planner placed it, on its day of the first plan's
 * days, so that its pots and a dish cooked ahead come out as they did; the meals of one's own, the leftovers and what
 * the diary of a day holds (`diaries`, by plan) are what stays on a day, as the plan was made around them. A leftover
 * was cooked with the meal it was left of: its dish and its rests are taken of the packs on the day that meal was
 * cooked. A meal eaten, or of a day gone (before `today`), keeps its rests: where the work gives it less of a pack than
 * it took (a meal after it now takes from the pack and finishes it), what it took beyond is gone from the pack, and the
 * rests are worked out again with that.
 */
function restsOfKitchen(
  plans: readonly KitchenPlan[],
  level: WasteLevel,
  toppingFoods: ReadonlyMap<string, PackFood>,
  today: string,
  diaries: readonly ReadonlyMap<string, DiaryOnDay>[],
): Map<string, StoredRest[]> & { counted: ReadonlySet<string> } {
  const dayOf = new Map(plans[0]!.days.map((day, index) => [isoDate(day.date), index]));
  /** What stays as it is takes of the packs on each day of the first plan's days. */
  const fixed = new Map<string, number[]>();
  const take = (ingredientId: string, day: number, amount: number): void => {
    let row = fixed.get(ingredientId);
    if (!row) {
      row = plans[0]!.days.map(() => 0);
      fixed.set(ingredientId, row);
    }
    row[day]! += amount;
  };
  const packs = new Map<string, Pack>();
  const foods = new Map<string, PackFood>();
  const count = (food: PackFood): void => {
    if (!food.perishable || !food.packSize || food.packSize <= 0) return;
    // Eggs and tortillas are taken whole by their pots: their packs are not counted here.
    if (food.slug && WHOLE_PIECE_SLUGS.includes(food.slug)) return;
    packs.set(food.id, {
      size: food.packSize,
      keepDays: level.keepDays(food),
      ...(level.freezes?.(food) ? { freezes: true } : {}),
    });
    foods.set(food.id, food);
  };

  const placed = plans.map(() => [] as KitchenMeal[]);
  const restPlans: RestPlan[] = plans.map((plan, p) => {
    const days = plans[0]!.days.map((day) => {
      const diary = diaries[p]!.get(isoDate(day.date));
      return {
        dailyCalorieTarget:
          plan.days.find((one) => isoDate(one.date) === isoDate(day.date))?.calorieTarget ??
          day.calorieTarget,
        kept: diary ? [{ calories: diary.nutrition.calories }] : ([] as { calories: number }[]),
      };
    });
    const recipes = new Map<string, RestPlan['recipes'][number]>();
    const assignments: RestPlan['assignments'][number][] = [];
    const toppings = new Map<number, { ingredientId: string; amount: number; calories: number }>();
    const shares = new Map<number, Map<string, number>>();
    const mealPrepFriendly = PlanOptions.safeParse(plan.options).data?.mealPrepFriendly ?? false;
    const cookedOn = cookedDaysOf(plan.days, mealPrepFriendly);
    for (const day of plan.days) {
      const dayIndex = dayOf.get(isoDate(day.date));
      if (dayIndex === undefined) continue;
      for (const meal of day.meals) {
        const cooks =
          meal.source !== 'USER_CUSTOM' && meal.recipe && meal.recipeId && !meal.leftoverFromDate;
        if (!cooks) {
          // A meal of one's own, or a leftover: what it holds stays on the day.
          const calories =
            meal.source === 'USER_CUSTOM' || !meal.recipe
              ? customMacros(meal.customMacros).calories * meal.servings * meal.quantityScale
              : meal.recipe.caloriesPerServing * meal.servings * meal.quantityScale;
          days[dayIndex]!.kept.push({ calories });
          const own = cookedOn.get(meal.id);
          const cooked = own === undefined ? undefined : dayOf.get(isoDate(plan.days[own]!.date));
          if (meal.leftoverFromDate && meal.recipe && cooked !== undefined) {
            const plate = plateOfMeal(meal.plate);
            for (const line of meal.recipe.ingredients) {
              count(line.ingredient);
              try {
                take(
                  line.ingredientId,
                  cooked,
                  (toCanonical(line.quantity, line.unit, line.ingredient) /
                    Math.max(1, meal.recipe.servings)) *
                    meal.servings *
                    meal.quantityScale *
                    (plate ? plateShare(plate, line.ingredient) : 1),
                );
              } catch (err) {
                if (!(err instanceof UnitConversionError)) throw err;
              }
            }
            for (const rest of restsOf(meal.rests)) take(rest.ingredientId, cooked, rest.amount);
          }
          continue;
        }
        const recipe = meal.recipe!;
        if (!recipes.has(recipe.id)) {
          const amounts = new Map<string, number>();
          for (const line of recipe.ingredients) {
            count(line.ingredient);
            try {
              const perServing =
                toCanonical(line.quantity, line.unit, line.ingredient) /
                Math.max(1, recipe.servings);
              amounts.set(line.ingredientId, (amounts.get(line.ingredientId) ?? 0) + perServing);
            } catch (err) {
              if (!(err instanceof UnitConversionError)) throw err;
            }
          }
          recipes.set(recipe.id, {
            id: recipe.id,
            amounts,
            caloriesPerServing: recipe.caloriesPerServing,
          });
        }
        const index = assignments.length;
        assignments.push({
          dayIndex,
          slot: meal.mealType as MealType,
          recipeId: recipe.id,
          servings: meal.servings,
          quantityScale: meal.quantityScale,
        });
        placed[p]!.push(meal);
        const food = meal.toppingKey !== null ? toppingFoods.get(meal.toppingKey) : undefined;
        if (food && meal.toppingAmount !== null) {
          count(food);
          toppings.set(index, {
            ingredientId: food.id,
            amount: meal.toppingAmount,
            calories: (food.caloriesPer100 * meal.toppingAmount) / 100,
          });
        }
        const plate = plateOfMeal(meal.plate);
        if (plate)
          shares.set(
            index,
            new Map(
              recipe.ingredients.map((line) => [
                line.ingredientId,
                plateShare(plate, line.ingredient),
              ]),
            ),
          );
      }
    }
    return {
      recipes: [...recipes.values()],
      days,
      assignments,
      mealPrepFriendly,
      toppings,
      shares,
    };
  });

  // The meals both people eat of one dish: the first plan's place and the second's at the same day and time of day.
  const shared: { dayIndex: number; slot: MealType }[] = [];
  if (plans.length === 2) {
    const theirs = new Map(
      placed[1]!.flatMap((meal) => (meal.sharedMealId ? [[meal.sharedMealId, meal] as const] : [])),
    );
    restPlans[0]!.assignments.forEach((place, index) => {
      const meal = placed[0]![index]!;
      const other = meal.sharedMealId ? theirs.get(meal.sharedMealId) : undefined;
      if (other && other.recipeId === meal.recipeId)
        shared.push({ dayIndex: place.dayIndex, slot: place.slot });
    });
  }

  const input: RestInput = {
    plans: restPlans,
    shared,
    fixed,
    packs,
    energyPer100: new Map([...foods].map(([id, food]) => [id, food.caloriesPer100])),
    caps: level.rests,
  };
  let given = packRests(input);
  // What a meal that keeps its rests took of a pack beyond what the work gives it is gone from the pack, on the day
  // its dish was cooked.
  const cookedOnDay = new Map<string, number>();
  for (const pot of potsOf(restPlans, shared).pots)
    pot.places.forEach((place, i) =>
      cookedOnDay.set(`${place.plan}:${place.index}`, pot.takenOn[i]!),
    );
  let beyond = false;
  placed.forEach((meals, p) =>
    meals.forEach((meal, index) => {
      const dayIndex = restPlans[p]!.assignments[index]!.dayIndex;
      if (meal.eatenAt === null && isoDate(plans[0]!.days[dayIndex]!.date) >= today) return;
      const took = new Map<string, number>();
      for (const rest of restsOf(meal.rests))
        if (packs.has(rest.ingredientId))
          took.set(rest.ingredientId, (took.get(rest.ingredientId) ?? 0) + rest.amount);
      for (const [ingredientId, amount] of took) {
        const worked = (given[p]!.get(index) ?? [])
          .filter((rest) => rest.ingredientId === ingredientId)
          .reduce((sum, rest) => sum + rest.amount, 0);
        // A rest is kept to the tenth.
        if (amount - worked <= 0.05) continue;
        take(ingredientId, cookedOnDay.get(`${p}:${index}`) ?? dayIndex, amount - worked);
        beyond = true;
      }
    }),
  );
  if (beyond) given = packRests(input);
  const worked = new Map<string, StoredRest[]>() as Map<string, StoredRest[]> & {
    counted: ReadonlySet<string>;
  };
  placed.forEach((meals, p) =>
    meals.forEach((meal, index) => {
      worked.set(
        meal.id,
        (given[p]!.get(index) ?? []).flatMap((rest) => {
          const food = foods.get(rest.ingredientId);
          const stored = food ? storedRestOf(food, rest) : null;
          return stored ? [stored] : [];
        }),
      );
    }),
  );
  return Object.assign(worked, { counted: new Set(packs.keys()) });
}

/**
 * The plans kept before their rests followed their packs are brought to it once, when the application starts: each
 * plan that wastes less or nothing and has days from today on takes the rests its packs leave as it stands now, and a
 * plan whose rests change moves on, so that a client that holds it reads it again. A start that finds nothing to change
 * writes nothing.
 */
@Injectable()
export class RestsFollowOnStart implements OnApplicationBootstrap {
  private readonly logger = new Logger('Plans');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const meals = await this.bring();
      if (meals > 0)
        this.logger.log(`Brought the rests of ${meals} meals to what their packs leave.`);
    } catch (err) {
      // A start goes on without it: a plan's rests follow its packs at its next change all the same.
      this.logger.error(`Could not bring the rests of the plans to their packs: ${String(err)}`);
    }
  }

  /** Brings the rests of every plan that counts its packs to what they leave; answers how many meals it wrote. */
  async bring(today: string = new Date().toISOString().slice(0, 10)): Promise<number> {
    const plans = await this.prisma.mealPlan.findMany({
      where: {
        OR: [
          { options: { path: ['lessWaste'], equals: true } },
          { options: { path: ['noWaste'], equals: true } },
        ],
        days: { some: { date: { gte: new Date(today) } } },
      },
      select: { id: true, jointPlanId: true },
      orderBy: { id: 'asc' },
    });
    const kitchens = new Set<string>();
    let written = 0;
    for (const plan of plans) {
      const kitchen = plan.jointPlanId ?? plan.id;
      if (kitchens.has(kitchen)) continue;
      kitchens.add(kitchen);
      written += await this.prisma.$transaction(async (tx) => {
        // The plans of the kitchen held in one order, as every write of a kitchen holds them: no change of a plan comes
        // between the reading of its rests and their writing.
        await tx.$queryRaw(
          plan.jointPlanId
            ? Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "jointPlanId" = ${plan.jointPlanId} ORDER BY "id" FOR UPDATE`
            : Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "id" = ${plan.id} FOR UPDATE`,
        );
        const followed = await followRests(tx, plan.id, today);
        for (const changed of new Set(followed.map((one) => one.planId)))
          await tx.mealPlan.update({
            where: { id: changed },
            data: { revision: { increment: 1 } },
          });
        return followed.length;
      });
    }
    return written;
  }
}
