// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { PlanOptions, ProteinKind, type PlanRelaxation } from '@diet-app/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { kindMealsAround, limitsBroken, proteinKindsOf } from '../engine/index.js';
import { storedKindLimits } from '../common/stored-kind-limits.js';
import { parseDayOverrides } from './plan-days.js';

/** What the lines of a recipe have to say for the kinds of protein it counts as. */
export const LINES_OF_KINDS = {
  orderBy: { position: 'asc' },
  select: {
    ingredientId: true,
    quantity: true,
    unit: true,
    ingredient: {
      select: {
        canonicalUnit: true,
        gramsPerPiece: true,
        density: true,
        proteinPer100: true,
        proteinKind: true,
      },
    },
  },
} satisfies Prisma.Recipe$ingredientsArgs;

/** A recipe, as far as the limits of a plan ask about it. */
export interface LimitedRecipe {
  id: string;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: Parameters<typeof proteinKindsOf>[0]['ingredients'];
}

interface Preferences {
  maxConsecutiveDaysSameMeal: number;
  maxTimesPerWeekSameMeal: number;
  maxMealsPerDaySameKind: number | null;
  maxMealsPerWeekSameKind: number | null;
  kindLimits: unknown;
}

/**
 * The most meals of a day and of seven days that may hold each kind of
 * protein: a kind's own numbers where the profile gives it some, the
 * profile's two for every kind where it does not. A kind with neither is left
 * out, and with it the limit.
 */
export function mealsPerKind(
  preferences: Pick<
    Preferences,
    'maxMealsPerDaySameKind' | 'maxMealsPerWeekSameKind' | 'kindLimits'
  > | null,
): Map<ProteinKind, { perDay?: number; perWeek?: number }> {
  const own = new Map(
    storedKindLimits(preferences?.kindLimits).map((limit) => [limit.kind, limit]),
  );
  const limits = new Map<ProteinKind, { perDay?: number; perWeek?: number }>();
  for (const kind of ProteinKind.options) {
    const perDay = own.get(kind)?.perDay ?? preferences?.maxMealsPerDaySameKind ?? undefined;
    const perWeek = own.get(kind)?.perWeek ?? preferences?.maxMealsPerWeekSameKind ?? undefined;
    if (perDay !== undefined || perWeek !== undefined) limits.set(kind, { perDay, perWeek });
  }
  return limits;
}

/**
 * How many days in a row and times in seven days a plan holds a recipe. A plan
 * for cooking ahead asks for cook-once-eat-many, so that the profile's caps are
 * raised to a generous baseline, however strict they are.
 */
export function capsOnARecipe(
  preferences: Pick<Preferences, 'maxConsecutiveDaysSameMeal' | 'maxTimesPerWeekSameMeal'> | null,
  mealPrepFriendly: boolean,
): { consecutive: number; perWeek: number } {
  const consecutive = preferences?.maxConsecutiveDaysSameMeal ?? 2;
  const perWeek = preferences?.maxTimesPerWeekSameMeal ?? 3;
  return mealPrepFriendly
    ? { consecutive: Math.max(consecutive, 4), perWeek: Math.max(perWeek, 5) }
    : { consecutive, perWeek };
}

/** One meal of a plan as its limits count it. */
interface CountedMeal {
  id: string;
  day: number;
  recipeId: string;
  kinds: readonly ProteinKind[];
}

/**
 * The limits of a plan as it stands: what a recipe would be outside of, on a
 * meal of it. They are the ones its days were filled inside (`limitsBroken`),
 * so that a change of one meal is held to what the plan was made with.
 */
export class PlanLimits {
  constructor(
    private readonly meals: readonly CountedMeal[],
    private readonly budgets: readonly (number | undefined)[],
    private readonly limits: Parameters<typeof limitsBroken>[1]['limits'],
  ) {}

  /**
   * What `recipe` would be outside of on a meal of the day at `day`, with the
   * meals `leaving` gone from the plan, and with it on the days `alsoOn` too.
   */
  breaks(
    recipe: LimitedRecipe,
    day: number,
    leaving: ReadonlySet<string>,
    alsoOn: readonly number[] = [],
  ): PlanRelaxation[] {
    const staying = this.meals.filter((meal) => !leaving.has(meal.id));
    const uses = [
      ...staying
        .filter((meal) => meal.recipeId === recipe.id)
        .map((meal) => ({ day: meal.day, recipeId: meal.recipeId })),
      ...alsoOn.map((other) => ({ day: other, recipeId: recipe.id })),
    ];
    const kinds = proteinKindsOf(recipe);
    const daysOfKind = (kind: ProteinKind): number[] => [
      ...staying.filter((meal) => meal.kinds.includes(kind)).map((meal) => meal.day),
      ...(kinds.includes(kind) ? alsoOn : []),
    ];
    return [
      ...limitsBroken(
        {
          id: recipe.id,
          proteinKinds: kinds,
          totalMinutes: recipe.prepMinutes + recipe.cookMinutes,
        },
        {
          day,
          usesOf: (id) => (id === recipe.id ? uses : []),
          useCount: new Map([[recipe.id, uses.length]]),
          mealsOfKind: (kind) => kindMealsAround(daysOfKind(kind), day),
          limits: this.limits,
          cookTimeBudget: this.budgets[day],
        },
      ),
    ];
  }
}

/** The limits of a plan as it stands now. `operatorRepeats` is the most times a recipe is on a plan that names no number. */
export async function readPlanLimits(
  db: Pick<PrismaClient, 'mealPlanDay'>,
  plan: {
    id: string;
    options: unknown;
    profile: { preferences: Preferences | null };
  },
  operatorRepeats: number | undefined,
): Promise<PlanLimits> {
  const days = await db.mealPlanDay.findMany({
    where: { planId: plan.id },
    orderBy: { date: 'asc' },
    select: {
      overrides: true,
      meals: {
        select: {
          id: true,
          recipeId: true,
          recipe: { select: { ingredients: LINES_OF_KINDS } },
        },
      },
    },
  });
  const made = PlanOptions.parse(plan.options);
  const { preferences } = plan.profile;
  return new PlanLimits(
    days.flatMap((day, index) =>
      day.meals.flatMap((meal) =>
        meal.recipeId && meal.recipe
          ? [
              {
                id: meal.id,
                day: index,
                recipeId: meal.recipeId,
                kinds: proteinKindsOf(meal.recipe),
              },
            ]
          : [],
      ),
    ),
    days.map((day) => parseDayOverrides(day.overrides)?.cookTimeBudgetMinutes),
    {
      ...capsOnARecipe(preferences, made.mealPrepFriendly),
      perPlan: made.maxRepeatsPerRecipe ?? operatorRepeats,
      twiceADay: made.mealPrepFriendly || made.allowRelaxations.includes('same_day'),
      perKind: mealsPerKind(preferences),
    },
  );
}
