// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  MAX_MEALS_ON_A_PLAN_DAY,
  PlanOptions,
  type LeftoverOffer,
  type Locale,
  type MealType,
  type PutLeftoverRequest,
  type RebalanceResult,
} from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { pickTitle } from '../recipes/recipes.service.js';
import { dateAfter, givesALeftover, takesALeftover } from './leftovers.js';
import { MealPlansService, mealRank, type CookedMeal } from './meal-plans.service.js';
import { isoDate, isSkipped, MADE_LAST, mealNutrition } from './plan-days.js';
import { writePlans } from './plan-write.js';

/** A meal as it was before a leftover took its place or was left of it: what undoing the leftover writes back. */
const StoredMeal = z.object({
  id: z.string(),
  dayId: z.string(),
  mealType: z.string(),
  recipeId: z.string().nullable(),
  source: z.enum(['CATALOGUE', 'USER_CUSTOM']),
  customName: z.string().nullable(),
  customMacros: z.unknown(),
  estimated: z.boolean(),
  servings: z.number(),
  quantityScale: z.number(),
  swapHistory: z.array(z.string()),
  eatenAt: z.string().nullable(),
  modelPicked: z.boolean(),
  modelReason: z.string().nullable(),
  /** Its topping; left out by a leftover kept before toppings were. */
  toppingKey: z.string().nullable().optional(),
  toppingAmount: z.number().nullable().optional(),
  /** The shared meal it was part of: linked again where the other person's meal still holds the dish there. */
  shared: z
    .object({ jointPlanId: z.string(), apart: z.boolean(), otherMealId: z.string() })
    .nullable(),
});
type StoredMeal = z.infer<typeof StoredMeal>;

/** What undoing a leftover brings back, kept on the leftover's row. */
const StoredLeftover = z.object({
  /** The meal the leftover took the place of, on the leftover's own row. */
  replaced: StoredMeal,
  /** The meal it was left of: `kept` on its day with the part eaten, or taken off it. */
  source: StoredMeal.extend({ kept: z.boolean() }),
});
type StoredLeftover = z.infer<typeof StoredLeftover>;

/** A meal of a plan with what a leftover reads of it. */
const MEAL = {
  day: { include: { plan: { select: { id: true, revision: true, profileId: true } } } },
  recipe: { select: { caloriesPerServing: true } },
} as const;
type Meal = Prisma.PlannedMealGetPayload<{ include: typeof MEAL }>;

/** The next day of a meal's, in the plan of the person made last that holds it. */
const NEXT_DAY = {
  plan: { select: { id: true, revision: true, options: true, jointPlanId: true } },
  meals: {
    include: {
      recipe: {
        select: {
          title: true,
          caloriesPerServing: true,
          proteinPerServing: true,
          fatPerServing: true,
          carbsPerServing: true,
          translations: { select: { locale: true, title: true } },
        },
      },
    },
  },
} as const;
type NextDayRow = Prisma.MealPlanDayGetPayload<{ include: typeof NEXT_DAY }>;

/** One person's part of a leftover: the meal it is left of and the meal of the next day it takes the place of. */
interface Carrying {
  source: Meal;
  next: NextDayRow;
  target: NextDayRow['meals'][number];
}

/** The fields of a meal a stored one writes back, its shared link aside. */
const fieldsOf = (meal: StoredMeal) => ({
  mealType: meal.mealType,
  recipeId: meal.recipeId,
  source: meal.source,
  customName: meal.customName,
  customMacros: (meal.customMacros ?? Prisma.JsonNull) as Prisma.InputJsonValue,
  estimated: meal.estimated,
  servings: meal.servings,
  quantityScale: meal.quantityScale,
  swapHistory: meal.swapHistory,
  eatenAt: meal.eatenAt ? new Date(meal.eatenAt) : null,
  modelPicked: meal.modelPicked,
  modelReason: meal.modelReason,
  toppingKey: meal.toppingKey ?? null,
  toppingAmount: meal.toppingAmount ?? null,
  sharedMealId: null,
});

/**
 * Leftovers: what is left of a meal of today or yesterday, put in as a meal of
 * the next day in the place of the dish planned there, and undone. A meal that
 * was eaten nothing of leaves its day, and the whole portion goes; a meal that
 * was eaten in part stays marked eaten with the part eaten, and the rest goes.
 * A leftover is cooked and bought already: it is pinned out of every rebalance,
 * and no list, pack, pantry or cooking counts it.
 */
@Injectable()
export class LeftoversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: MealPlansService,
  ) {}

  /** Where what is left of a meal can go, and the meals of the next day it may take the place of. Nothing is written. */
  async offer(
    userId: string,
    locale: Locale,
    planId: string,
    mealId: string,
    clientToday: string | null = null,
  ): Promise<LeftoverOffer> {
    const today = clientToday ?? this.plans.today();
    const source = await this.giver(userId, planId, mealId, today);
    const next = await this.nextDay(source);
    const places = next.meals
      .filter(takesALeftover)
      .sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType));
    if (places.length === 0) throw noPlace();
    const [cooked, sharedWith, other] = await Promise.all([
      this.plans.cookedWith(this.prisma, next.plan.id, PlanOptions.parse(next.plan.options)),
      this.sharedWith(userId, places),
      this.otherSide(userId, source),
    ]);
    const date = isoDate(next.date);
    return {
      planId: next.plan.id,
      date,
      portion: portionOf(source),
      places: places.map((meal) => {
        const cooking = cooked.get(meal.id) ?? [];
        return {
          mealType: meal.mealType as MealType,
          name:
            meal.source === 'USER_CUSTOM' || !meal.recipe
              ? (meal.customName ?? '')
              : pickTitle(locale, meal.recipe.translations, meal.recipe.title),
          calories: mealNutrition(meal).calories,
          sharedWith: sharedWith.get(meal.id) ?? null,
          cookAhead: cooking.length === 0 ? null : cooksFirst(date, meal.mealType, cooking),
          cookedWith: cooking.map((one) => ({
            mealId: one.id,
            date: one.date,
            mealType: one.mealType,
            eaten: one.eaten,
          })),
        };
      }),
      other: other && {
        profileName: other.profileName,
        eaten: other.source.eatenAt !== null,
        portion: portionOf(other.source),
        places: other.next.meals
          .filter(takesALeftover)
          .sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType))
          .map((meal) => meal.mealType as MealType),
      },
    };
  }

  /**
   * Put what is left of a meal in as a meal of the next day at `mealType`, in
   * the place of the dish there, and size both days again. For both people of
   * a shared meal, the other person's leftover goes to the same time of day of
   * their next day, and the two are shared there.
   */
  async put(
    userId: string,
    locale: Locale,
    planId: string,
    mealId: string,
    req: PutLeftoverRequest,
    clientToday: string | null = null,
  ): Promise<RebalanceResult> {
    const today = clientToday ?? this.plans.today();
    const source = await this.giver(userId, planId, mealId, today);
    const mine = this.carrying(source, await this.nextDay(source), req.mealType);
    let theirs: Carrying | null = null;
    if (req.forAll) {
      const other = await this.otherSide(userId, source);
      if (!other)
        throw new NotFoundException({
          error: 'MEAL_NOT_FOUND',
          message: 'The other person has no portion of this meal to carry.',
        });
      theirs = this.carrying(other.source, other.next, req.mealType);
    }
    const sides = theirs ? [mine, theirs] : [mine];
    await writePlans(this.prisma, claims(sides), async (tx) => {
      const sourceShare = await this.sharedOf(tx, source);
      await this.carry(tx, mine, req.left, theirs === null);
      if (theirs) {
        await this.carry(tx, theirs, req.theirLeft ?? req.left, false);
        await this.shareLeftovers(tx, mine, theirs, sourceShare?.apart ?? false);
      }
      for (const dayId of new Set(sides.flatMap((side) => [side.source.dayId, side.next.id])))
        await this.plans.rebalanceDayInternal(dayId, tx, today);
    });
    return this.plans.buildRebalanceResult(userId, locale, planId, 'day', null);
  }

  /**
   * Undo a leftover that is not eaten: the dish it took the place of comes back
   * on its row, and the meal it was left of comes back as it was, where its day
   * still has room for it; both days are sized again. `forAll` undoes the other
   * person's leftover shared with it as well, where they have not eaten it.
   */
  async undo(
    userId: string,
    locale: Locale,
    planId: string,
    mealId: string,
    forAll: boolean,
    clientToday: string | null = null,
  ): Promise<RebalanceResult> {
    const today = clientToday ?? this.plans.today();
    const meal = await this.plans.loadPlannedMeal(userId, planId, mealId);
    const mine = { meal, stored: undoOf(meal) };
    const other = forAll ? await this.plans.otherOfShared(userId, meal) : null;
    const theirs =
      other && other.leftoverFromDate && other.eatenAt === null && other.leftoverUndo
        ? { meal: other, stored: undoOf(other) }
        : null;
    const sides = theirs ? [mine, theirs] : [mine];
    // The days the meals they were left of were on, where those are still there.
    const sourceDays = await this.prisma.mealPlanDay.findMany({
      where: {
        id: { in: sides.map((side) => side.stored.source.dayId) },
        plan: { profile: { userId } },
      },
      select: { id: true, plan: { select: { id: true, revision: true } } },
    });
    const plans = new Map<string, number>();
    for (const { meal: one } of sides) plans.set(one.day.planId, one.day.plan.revision);
    for (const day of sourceDays)
      if (!plans.has(day.plan.id)) plans.set(day.plan.id, day.plan.revision);
    await writePlans(
      this.prisma,
      [...plans].map(([id, revision]) => ({ planId: id, revision })),
      async (tx) => {
        const restored: StoredMeal[] = [];
        for (const side of sides) {
          await tx.plannedMeal.update({
            where: { id: side.meal.id },
            data: {
              ...fieldsOf(side.stored.replaced),
              lastRebalanceAt: null,
              leftoverFromDate: null,
              leftoverFromMealType: null,
              leftoverUndo: Prisma.JsonNull,
            },
          });
          restored.push(side.stored.replaced);
          if (await this.putSourceBack(tx, side.meal, side.stored.source))
            restored.push(side.stored.source);
        }
        for (const one of restored) await this.linkAgain(tx, one);
        const days = new Set([
          ...sides.map((side) => side.meal.dayId),
          ...sourceDays.map((day) => day.id),
        ]);
        for (const dayId of days) await this.plans.rebalanceDayInternal(dayId, tx, today);
      },
    );
    return this.plans.buildRebalanceResult(userId, locale, planId, 'day', null);
  }

  /** A meal of the user's plan that may give a leftover now; otherwise why it may not. */
  private async giver(
    userId: string,
    planId: string,
    mealId: string,
    today: string,
  ): Promise<Meal> {
    const meal = await this.prisma.plannedMeal.findFirst({
      where: { id: mealId, day: { planId, plan: { profile: { userId } } } },
      include: MEAL,
    });
    // Deleted between two reads, its day or plan comes back null: it is on its way out.
    if (!meal?.day?.plan)
      throw new NotFoundException({ error: 'MEAL_NOT_FOUND', message: 'Planned meal not found.' });
    if (meal.source === 'USER_CUSTOM' || !meal.recipeId)
      throw new BadRequestException({
        error: 'LEFTOVER_OWN_MEAL',
        message: "A meal of one's own has no recipe whose rest could be carried.",
      });
    if (meal.leftoverFromDate)
      throw new ConflictException({
        error: 'MEAL_IS_LEFTOVER',
        message:
          'A leftover is cooked already: it is not changed or carried again. Undo the move or remove it from its day.',
      });
    if (meal.givenLeftoverId)
      throw new ConflictException({
        error: 'LEFTOVER_CARRIED',
        message: 'What was left of this meal is carried already.',
      });
    if (!givesALeftover(meal, isoDate(meal.day.date), today))
      throw new ConflictException({
        error: 'LEFTOVER_DAY',
        message: 'Only a meal of today or yesterday gives a leftover.',
      });
    return meal;
  }

  /** The day after a meal's in the plan of its person made last that holds it, unless no plan holds it or it is skipped. */
  private async nextDay(source: Meal): Promise<NextDayRow> {
    const next = await this.prisma.mealPlanDay.findFirst({
      where: {
        date: new Date(dateAfter(isoDate(source.day.date))),
        plan: { profileId: source.day.plan.profileId },
      },
      orderBy: [...MADE_LAST],
      include: NEXT_DAY,
    });
    if (!next)
      throw new ConflictException({
        error: 'LEFTOVER_NO_DAY',
        message: 'No plan of the profile holds the next day.',
      });
    if (isSkipped(next))
      throw new ConflictException({
        error: 'LEFTOVER_DAY_SKIPPED',
        message: 'The next day is skipped.',
      });
    return next;
  }

  /** The meal at `mealType` of the next day a leftover takes the place of. */
  private carrying(source: Meal, next: NextDayRow, mealType: MealType): Carrying {
    const target = next.meals.find((meal) => meal.mealType === mealType && takesALeftover(meal));
    if (!target) throw noPlace();
    return { source, next, target };
  }

  /**
   * The other person's side of a shared meal, for a leftover for both: their
   * meal, while it holds the dish and may give a leftover itself, and their
   * next day. Null where there is none of these.
   */
  private async otherSide(
    userId: string,
    source: Meal,
  ): Promise<{ source: Meal; next: NextDayRow; profileName: string } | null> {
    const other = await this.plans.otherOfShared(userId, source);
    if (!other) return null;
    const meal = await this.prisma.plannedMeal.findUnique({
      where: { id: other.id },
      include: MEAL,
    });
    if (!meal?.day?.plan || meal.leftoverFromDate || meal.givenLeftoverId) return null;
    const next = await this.nextDay(meal).catch(() => null);
    if (!next) return null;
    const profile = await this.prisma.profile.findUnique({
      where: { id: meal.day.plan.profileId },
      select: { name: true },
    });
    return profile ? { source: meal, next, profileName: profile.name } : null;
  }

  /** For each meal of `meals` shared with another person, that person's name. */
  private async sharedWith(
    userId: string,
    meals: readonly { id: string; sharedMealId: string | null }[],
  ): Promise<Map<string, string>> {
    const linked = meals.filter((meal) => meal.sharedMealId !== null);
    if (linked.length === 0) return new Map();
    const others = await this.prisma.plannedMeal.findMany({
      where: {
        sharedMealId: { in: linked.map((meal) => meal.sharedMealId!) },
        id: { notIn: linked.map((meal) => meal.id) },
        day: { plan: { profile: { userId } } },
      },
      select: {
        sharedMealId: true,
        day: { select: { plan: { select: { profile: { select: { name: true } } } } } },
      },
    });
    const names = new Map<string, string>();
    for (const meal of linked) {
      const other = others.find((one) => one.sharedMealId === meal.sharedMealId);
      if (other) names.set(meal.id, other.day.plan.profile.name);
    }
    return names;
  }

  /** The shared meal a meal is part of, with the other person's meal of it. */
  private async sharedOf(
    tx: Prisma.TransactionClient,
    meal: { id: string; sharedMealId: string | null },
  ): Promise<StoredMeal['shared']> {
    if (!meal.sharedMealId) return null;
    const shared = await tx.sharedMeal.findUnique({
      where: { id: meal.sharedMealId },
      select: { jointPlanId: true, apart: true, meals: { select: { id: true } } },
    });
    const other = shared?.meals.find((one) => one.id !== meal.id);
    return shared && other
      ? { jointPlanId: shared.jointPlanId, apart: shared.apart, otherMealId: other.id }
      : null;
  }

  /** A meal as it is now, to be written back by an undo. */
  private async stored(
    tx: Prisma.TransactionClient,
    meal: Prisma.PlannedMealGetPayload<object>,
  ): Promise<StoredMeal> {
    return {
      id: meal.id,
      dayId: meal.dayId,
      mealType: meal.mealType,
      recipeId: meal.recipeId,
      source: meal.source,
      customName: meal.customName,
      customMacros: meal.customMacros,
      estimated: meal.estimated,
      servings: meal.servings,
      quantityScale: meal.quantityScale,
      swapHistory: meal.swapHistory,
      eatenAt: meal.eatenAt?.toISOString() ?? null,
      modelPicked: meal.modelPicked,
      modelReason: meal.modelReason,
      toppingKey: meal.toppingKey,
      toppingAmount: meal.toppingAmount,
      shared: await this.sharedOf(tx, meal),
    };
  }

  /**
   * Write one person's leftover: the meal it is left of leaves its day, or,
   * eaten in part, keeps the part eaten and is marked eaten; the meal of the
   * next day takes the dish with the part left. `alone`: a leftover for one,
   * which is no shared meal there.
   */
  private async carry(
    tx: Prisma.TransactionClient,
    { source, target }: Carrying,
    left: number,
    alone: boolean,
  ): Promise<void> {
    const kept = left < 1;
    const undo: StoredLeftover = {
      replaced: await this.stored(tx, target),
      source: { ...(await this.stored(tx, source)), kept },
    };
    if (kept)
      await tx.plannedMeal.update({
        where: { id: source.id },
        data: {
          quantityScale: source.quantityScale * (1 - left),
          eatenAt: source.eatenAt ?? new Date(),
          givenLeftoverId: target.id,
          carriedToMealType: target.mealType,
        },
      });
    else await tx.plannedMeal.delete({ where: { id: source.id } });
    await tx.plannedMeal.update({
      where: { id: target.id },
      data: {
        recipeId: source.recipeId,
        source: 'CATALOGUE',
        customName: null,
        customMacros: Prisma.JsonNull,
        estimated: false,
        servings: source.servings,
        quantityScale: source.quantityScale * left,
        swapHistory: [],
        modelPicked: false,
        modelReason: null,
        lastRebalanceAt: null,
        // A leftover is the dish as it was cooked: nothing is put on its plate.
        toppingKey: null,
        toppingAmount: null,
        ...(alone ? { sharedMealId: null } : {}),
        leftoverFromDate: source.day.date,
        leftoverFromMealType: source.mealType,
        leftoverUndo: undo as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * The two leftovers of a shared meal, shared at their time of day where both
   * plans are of one joint plan; each the person's own otherwise.
   */
  private async shareLeftovers(
    tx: Prisma.TransactionClient,
    mine: Carrying,
    theirs: Carrying,
    apart: boolean,
  ): Promise<void> {
    const jointPlanId = mine.next.plan.jointPlanId;
    const ids = [mine.target.id, theirs.target.id];
    if (!jointPlanId || jointPlanId !== theirs.next.plan.jointPlanId) {
      await tx.plannedMeal.updateMany({ where: { id: { in: ids } }, data: { sharedMealId: null } });
      return;
    }
    const shared = await tx.sharedMeal.upsert({
      where: {
        jointPlanId_date_mealType: {
          jointPlanId,
          date: mine.next.date,
          mealType: mine.target.mealType,
        },
      },
      create: { jointPlanId, date: mine.next.date, mealType: mine.target.mealType, apart },
      update: { apart },
    });
    await tx.plannedMeal.updateMany({
      where: { id: { in: ids } },
      data: { sharedMealId: shared.id },
    });
  }

  /**
   * Bring back the meal a leftover was left of: the part eaten put back to
   * the whole, or the meal written again in its place, where its day is still
   * there and holds no dish at that time of day. Whether it came back.
   */
  private async putSourceBack(
    tx: Prisma.TransactionClient,
    leftover: { id: string },
    source: StoredLeftover['source'],
  ): Promise<boolean> {
    if (source.kept) {
      // The meal it was left of says so while it is there.
      const restored = await tx.plannedMeal.updateMany({
        where: { id: source.id, givenLeftoverId: leftover.id },
        data: {
          quantityScale: source.quantityScale,
          eatenAt: source.eatenAt ? new Date(source.eatenAt) : null,
          givenLeftoverId: null,
          carriedToMealType: null,
        },
      });
      return restored.count === 1;
    }
    const day = await tx.mealPlanDay.findUnique({
      where: { id: source.dayId },
      select: { meals: { select: { id: true, mealType: true, source: true } } },
    });
    if (
      !day ||
      day.meals.length >= MAX_MEALS_ON_A_PLAN_DAY ||
      day.meals.some(
        (meal) =>
          meal.id === source.id ||
          (meal.mealType === source.mealType && meal.source === 'CATALOGUE'),
      )
    )
      return false;
    await tx.plannedMeal.create({
      data: { id: source.id, dayId: source.dayId, ...fieldsOf(source) },
    });
    return true;
  }

  /**
   * Link a meal written back to the other person's meal it was shared with,
   * where that meal is still there, at the same day and time of day, holding
   * the same dish.
   */
  private async linkAgain(tx: Prisma.TransactionClient, meal: StoredMeal): Promise<void> {
    if (!meal.shared || !meal.recipeId) return;
    const [mine, theirs] = await Promise.all(
      [meal.id, meal.shared.otherMealId].map((id) =>
        tx.plannedMeal.findUnique({
          where: { id },
          select: { id: true, mealType: true, recipeId: true, day: { select: { date: true } } },
        }),
      ),
    );
    if (
      !mine ||
      !theirs ||
      theirs.recipeId !== mine.recipeId ||
      theirs.mealType !== mine.mealType ||
      isoDate(theirs.day.date) !== isoDate(mine.day.date)
    )
      return;
    const key = {
      jointPlanId: meal.shared.jointPlanId,
      date: mine.day.date,
      mealType: mine.mealType,
    };
    const shared = await tx.sharedMeal.upsert({
      where: { jointPlanId_date_mealType: key },
      create: { ...key, apart: meal.shared.apart },
      update: { apart: meal.shared.apart },
    });
    await tx.plannedMeal.updateMany({
      where: { id: { in: [mine.id, theirs.id] } },
      data: { sharedMealId: shared.id },
    });
  }
}

/** The refusal where no meal of the next day can take a leftover at the time asked. */
const noPlace = () =>
  new ConflictException({
    error: 'LEFTOVER_NO_PLACE',
    message:
      'The next day has no meal at that time of day a leftover can take the place of: it is eaten or a leftover itself.',
  });

/** The whole portion of a meal: its servings as eaten and its kcal. */
const portionOf = (meal: Meal) => ({
  servings: meal.servings * meal.quantityScale,
  calories: Math.round((meal.recipe?.caloriesPerServing ?? 0) * meal.servings * meal.quantityScale),
});

/** Whether the meal at `mealType` of `date` is the one its cooking is cooked at, the first of them, or eaten from it. */
const cooksFirst = (
  date: string,
  mealType: string,
  others: readonly CookedMeal[],
): 'cook' | 'cooked' =>
  others.every(
    (other) =>
      other.date > date || (other.date === date && mealRank(other.mealType) > mealRank(mealType)),
  )
    ? 'cook'
    : 'cooked';

/** The plans a change of leftovers writes, each at the revision it was read at. */
function claims(sides: readonly Carrying[]): { planId: string; revision: number }[] {
  const plans = new Map<string, number>();
  for (const { source, next } of sides) {
    plans.set(source.day.plan.id, source.day.plan.revision);
    plans.set(next.plan.id, next.plan.revision);
  }
  return [...plans].map(([planId, revision]) => ({ planId, revision }));
}

/** What undoing a leftover brings back; why it cannot be undone otherwise. */
function undoOf(meal: {
  leftoverFromDate: Date | null;
  eatenAt: Date | null;
  leftoverUndo: unknown;
}): StoredLeftover {
  if (!meal.leftoverFromDate)
    throw new ConflictException({ error: 'NOT_A_LEFTOVER', message: 'This meal is no leftover.' });
  if (meal.eatenAt)
    throw new ConflictException({
      error: 'MEAL_EATEN',
      message: 'A meal that was eaten cannot be changed. Unmark it first.',
    });
  const stored = StoredLeftover.safeParse(meal.leftoverUndo);
  if (!stored.success)
    throw new ConflictException({ error: 'NOT_A_LEFTOVER', message: 'This meal is no leftover.' });
  return stored.data;
}
