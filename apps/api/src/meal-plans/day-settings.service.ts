// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MEAL_SLOTS_BY_COUNT,
  PlanOptions,
  RegenerateDayRequest,
  type ApplyDaySettingsRequest,
  type DayMealFate,
  type DaySettings,
  type DaySettingsPreview,
  type EvenWeekRequest,
  type Locale,
  type MealPlan,
  type MealType,
} from '@diet-app/shared';
import { refuseUnderLeast } from '../common/typed-target.js';
import { diaryDays } from '../diary/diary-days.js';
import {
  calculateCalories,
  DAY_KIND_FACTOR,
  fitServings,
  KCAL_PER_KG_FAT,
  REBALANCE_TOLERANCE,
  safetyFloor,
  sharesTheWeek,
  slotBudgets,
  weekOfDay,
  weekScale,
  type KeptMeal,
  shownTarget,
} from '../engine/index.js';
import { calorieInputOf } from '../profiles/calorie-input.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StoredReport, withDaysAgain } from './generation-report.js';
import { cookingChange, MealPlansService, type CookedMeal } from './meal-plans.service.js';
import {
  aimOfDay,
  dayMealCount,
  isoDate,
  isSkipped,
  mealNutrition,
  parseDayOverrides,
  planMealCount,
  type DayOverridesJson,
  plateAsJson,
  wholeAddition,
  mealRank,
} from './plan-days.js';
import { PlanGenerationService } from './plan-generation.service.js';
import {
  asWeekDay,
  canTakeAnother,
  evenedScale,
  weekAverage,
  weekSlack,
  weeksOfPlan,
  type WeekPlanDay,
} from './plan-weeks.js';
import { writePlan } from './plan-write.js';
import { heldTimes } from './reroll-reading.js';
import { toppingKcal } from './toppings-store.js';
import type { PieceUse } from '../engine/whole-pieces.js';
import { pieceUsesOf, piecedDays } from './whole-pieces-store.js';

/** What a meal's recipe is read for here: what a serving holds, and how long it takes. */
const RECIPE = {
  select: {
    caloriesPerServing: true,
    proteinPerServing: true,
    fatPerServing: true,
    carbsPerServing: true,
    prepMinutes: true,
    cookMinutes: true,
  },
} as const;

/** The plan, the day and the profile a change of the day's settings is about. */
type Context = Awaited<ReturnType<DaySettingsService['read']>>;
type DayMeal = Context['day']['meals'][number];

/** What a change of a day's settings comes to, worked out once for the preview and the change alike. */
interface Change {
  overrides: DayOverridesJson | null;
  target: number;
  /** Each meal of the day, in the order they are eaten. */
  fates: DayMealFate[];
  /** The meals the day gains, in the order they are eaten. */
  added: MealType[];
  /** The meals a recipe is drawn for: those drawn again, then those the day gains. */
  drawn: MealType[];
  /** The dishes that stay take other portions: the day's target or its number of meals changes. */
  resizes: boolean;
  unchanged: boolean;
}

/**
 * The settings of a day of a running plan (`DaySettings`): what a change
 * would do, and the change. A change keeps what it can of the day: the
 * dishes stay where only the amount changes, and recipes are drawn only for
 * the meals the day gains and those a new limit rules out, inside the limits
 * of the plan as a day made again is. Eaten meals and the user's own stay as
 * they are; a day that is skipped keeps only what was eaten.
 */
@Injectable()
export class DaySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generation: PlanGenerationService,
    private readonly plans: MealPlansService,
  ) {}

  /** What changing the settings of a day to `settings` would do. Nothing is written. */
  async preview(
    userId: string,
    planId: string,
    dayId: string,
    settings: DaySettings,
    clientToday: string | null = null,
  ): Promise<DaySettingsPreview> {
    const context = await this.read(userId, planId, dayId, clientToday);
    const { plan, day, date } = context;
    const change = this.change(context, settings);
    const fateOf = new Map(change.fates.map((fate) => [fate.mealId, fate]));
    const left = day.meals.filter((meal) => fateOf.get(meal.id)!.fate !== 'removed');
    // What the diary holds for the day is eaten, and counts as the day's view counts it.
    const entered =
      (await diaryDays(this.prisma, plan.profileId, day.date, day.date, planId)).get(date) ?? null;
    // What the day comes to is known here only where no recipe is drawn; a skipped day has no target to fit.
    // The dishes that stay are sized as the change sizes them: no one past twice the portion the plan gave it.
    const resized =
      change.drawn.length === 0 && change.resizes
        ? this.plans.resizedDay(
            left,
            { calorieTarget: change.target, overrides: change.overrides },
            entered,
            plan,
          )
        : null;
    // What the pots take whole once the dishes are sized as the change sizes them, a meal it takes away gone.
    const piecesThen = resized
      ? await pieceUsesOf(
          this.prisma,
          left.map((meal) => meal.id),
          new Map([
            ...resized.scales,
            ...change.fates
              .filter((fate) => fate.fate === 'removed')
              .map((fate) => [fate.mealId, 0] as const),
          ]),
        )
      : new Map<string, PieceUse[]>();
    const dayCalories =
      change.drawn.length > 0
        ? null
        : resized
          ? Math.round(
              resized.kcal +
                left.reduce(
                  (sum, meal) => sum + wholeAddition(piecesThen.get(meal.id) ?? [], 'calories'),
                  0,
                ),
            )
          : left.reduce((sum, meal) => sum + mealNutrition(meal).calories, 0) +
            (await toppingKcal(this.prisma, left)) +
            (entered?.nutrition.calories ?? 0);
    const meals = change.fates.map((fate) => {
      const meal = left.find((one) => one.id === fate.mealId);
      if (fate.fate !== 'resized' || !resized || !meal) return fate;
      const now = meal.quantityScale;
      const then = resized.scales.get(meal.id) ?? now;
      const servings = {
        now: hundredths(meal.servings * now),
        then: hundredths(meal.servings * then),
      };
      // A dish the change cannot move, one at a bound of its portion, stays as it is.
      if (servings.now === servings.then) return { ...fate, fate: 'stays' as const };
      return {
        ...fate,
        portion: {
          servings,
          calories: {
            now: mealNutrition(meal).calories,
            then: mealNutrition({
              ...meal,
              quantityScale: then,
              pieces: piecesThen.get(meal.id) ?? [],
            }).calories,
          },
        },
      };
    });
    // A day its dishes cannot bring into its window from below: the rest may go to the days after it.
    const short =
      resized && !settings.skip && dayCalories! < change.target * (1 - REBALANCE_TOLERANCE)
        ? await this.shortOf(context, change, resized.scales, dayCalories!, clientToday)
        : null;
    const changesMeals =
      change.added.length > 0 || change.fates.some((fate) => fate.fate !== 'stays');
    const lists = changesMeals
      ? await this.prisma.shoppingList.count({
          where: { planId, fromDate: { lte: day.date }, toDate: { gte: day.date } },
        })
      : 0;
    const cookedWith = await this.plans.cookedWith(
      this.prisma,
      planId,
      PlanOptions.parse(plan.options),
    );
    return {
      revision: plan.revision,
      date,
      calorieTarget: { now: day.calorieTarget, then: change.target },
      targetMacros: {
        now: shownTarget(aimOfDay(day, plan), day.calorieTarget, plan.dietType),
        then: shownTarget(
          aimOfDay({ calorieTarget: change.target, overrides: change.overrides }, plan),
          change.target,
          plan.dietType,
        ),
      },
      belowSafetyFloor: !settings.skip && change.target < safetyFloor(context.profile.sex),
      meals,
      added: change.added,
      dayCalories,
      fits:
        dayCalories === null || settings.skip
          ? null
          : Math.abs(dayCalories - change.target) <= REBALANCE_TOLERANCE * change.target,
      short,
      listOutOfDate: lists > 0,
      unchanged: change.unchanged,
      cooking: cookingChange(
        change.fates
          .filter((fate) => fate.fate === 'redrawn')
          .flatMap((fate) => cookedWith.get(fate.mealId) ?? [])
          .filter((meal) => meal.dayId !== dayId),
        clientToday ?? this.plans.today(),
      ),
      week: await this.weekPreview(context, change),
    };
  }

  /**
   * What a day falls short of its new target by (`DaySettingsPreview.short`),
   * and what spreading it over the next days of the plan does: the same sizing
   * of the plan's rest that the change runs with `spreadShort` (`planRest`), on
   * the plan with this day as the change leaves it.
   */
  private async shortOf(
    context: Context,
    change: Change,
    scales: ReadonlyMap<string, number>,
    dayCalories: number,
    clientToday: string | null,
  ): Promise<DaySettingsPreview['short']> {
    const kcal = Math.round(change.target - dayCalories);
    const planned = await this.plans.planRest(
      this.prisma,
      context.plan.id,
      context.date,
      clientToday ?? this.plans.today(),
      {
        dayId: context.day.id,
        day: { calorieTarget: change.target, overrides: change.overrides },
        scales,
        gone: new Set(
          change.fates.filter((fate) => fate.fate === 'removed').map((fate) => fate.mealId),
        ),
      },
    );
    let takes = 0;
    const taking: string[] = [];
    for (const day of planned?.dayRows ?? []) {
      const { before, after } = planned!.kcal.get(day.id)!;
      if (day.id === context.day.id || after - before < 0.5) continue;
      takes += after - before;
      taking.push(day.date);
    }
    const taken = Math.min(kcal, Math.round(takes));
    // Why no day takes part, where none does: the plan ends with this day, its days after it are all skipped, or they
    // are at the top of their windows already.
    const later = context.plan.days.filter((one) => isoDate(one.date) > context.date);
    const none =
      taking.length > 0
        ? null
        : later.length === 0
          ? ('last_day' as const)
          : later.every((one) => isSkipped(one))
            ? ('skipped' as const)
            : ('full' as const);
    return {
      kcal,
      spread: {
        days: taking.length,
        takes: taken,
        left: kcal - taken,
        listOutOfDate: await this.listCovers(context.plan.id, taking),
        none,
      },
    };
  }

  /** Whether a shopping list of the plan covers one of `dates`. */
  private async listCovers(planId: string, dates: readonly string[]): Promise<boolean> {
    if (dates.length === 0) return false;
    const lists = await this.prisma.shoppingList.count({
      where: {
        planId,
        OR: dates.map((date) => ({
          fromDate: { lte: new Date(date) },
          toDate: { gte: new Date(date) },
        })),
      },
    });
    return lists > 0;
  }

  /**
   * The week of the day before and after the change (`DaySettingsPreview.week`):
   * the averages, the paces they come to, and what evening the week out gives.
   */
  private async weekPreview(context: Context, change: Change): Promise<DaySettingsPreview['week']> {
    const target = context.plan.calorieTarget;
    const after = this.weekAfter(context, change);
    const now = weekAverage(context.week);
    const alone = weekAverage(after);
    if (now === null || alone === null) return null;
    const evened = this.evened(context, after);
    const evenedWeek = after.map((day) => ({
      ...day,
      calorieTarget: evened.get(day.id) ?? day.calorieTarget,
    }));
    const evenedAverage = weekAverage(evenedWeek) ?? alone;
    const { maintenance } = calculateCalories(calorieInputOf(context.profile));
    const pace = (average: number): number =>
      Math.round(((maintenance - average) * 7 * 100) / KCAL_PER_KG_FAT) / 100;
    const others = after.filter(
      (day) =>
        day.id !== context.day.id && evened.has(day.id) && evened.get(day.id) !== day.calorieTarget,
    );
    const listed = await this.listCovers(
      context.plan.id,
      others.map((day) => day.date),
    );
    return {
      target,
      average: {
        now: Math.round(now),
        alone: Math.round(alone),
        evened: Math.round(evenedAverage),
      },
      pace: { now: pace(now), alone: pace(alone), evened: pace(evenedAverage) },
      unevenAlone:
        Math.abs(alone - target) > weekSlack(target) &&
        Math.abs(evenedAverage - target) < Math.abs(alone - target),
      evenedTarget: evened.get(context.day.id) ?? change.target,
      otherDays: others.length,
      listOutOfDate: listed,
    };
  }

  /** The week of the day as it would be with the change: the day with its new target and settings. */
  private weekAfter(context: Context, change: Change): WeekPlanDay[] {
    return context.week.map((day) =>
      day.id === context.day.id
        ? { ...day, calorieTarget: change.target, overrides: change.overrides }
        : day,
    );
  }

  /**
   * The targets that even `week` out (`evenedScale`), by the ids of the days
   * that can take another: each the plan's target at the evened scale, shaped
   * by its kind, as a day of a new plan is given its target.
   */
  private evened(context: Context, week: readonly WeekPlanDay[]): Map<string, number> {
    const targets = new Map<string, number>();
    const scale = evenedScale(week, context.plan.calorieTarget, context.today);
    if (scale === null) return targets;
    for (const day of week) {
      if (!canTakeAnother(day, context.today)) continue;
      const overrides = parseDayOverrides(day.overrides);
      targets.set(
        day.id,
        this.generation.targetOfDay(context.profile, context.plan, overrides, scale),
      );
    }
    return targets;
  }

  /**
   * Give the days of `evened` other than `dayId` their new targets, and bring
   * their dishes to them in other portions, as a change of a day's kind does.
   */
  private async evenOthers(
    tx: Prisma.TransactionClient,
    context: Context,
    evened: ReadonlyMap<string, number>,
  ): Promise<void> {
    for (const day of context.week) {
      const next = evened.get(day.id);
      if (day.id === context.day.id || next === undefined || next === day.calorieTarget) continue;
      await tx.mealPlanDay.update({ where: { id: day.id }, data: { calorieTarget: next } });
      await this.plans.rebalanceDayInternal(day.id, tx, context.today);
    }
  }

  /**
   * Even out the week of a plan that `request.date` is in (`EvenWeekRequest`),
   * on the plan as it was at `request.revision`.
   */
  async evenWeek(
    userId: string,
    locale: Locale,
    planId: string,
    request: EvenWeekRequest,
    clientToday: string | null = null,
  ): Promise<MealPlan> {
    const dayId = await this.plans.dayIdOf(userId, planId, request.date);
    const context = await this.read(userId, planId, dayId, clientToday, { pastAllowed: true });
    const evened = this.evened(context, context.week);
    const changes = context.week.some(
      (day) => evened.has(day.id) && evened.get(day.id) !== day.calorieTarget,
    );
    if (context.plan.revision !== request.revision) {
      throw new ConflictException({
        error: 'PLAN_CHANGED',
        message: 'The plan changed while this request was running. Reload it and try again.',
      });
    }
    if (changes) {
      await writePlan(
        this.prisma,
        planId,
        request.revision,
        clientToday ?? this.plans.today(),
        'week-evened',
        async (tx) => {
          const own = evened.get(context.day.id);
          if (own !== undefined && own !== context.day.calorieTarget) {
            await tx.mealPlanDay.update({ where: { id: dayId }, data: { calorieTarget: own } });
            await this.plans.rebalanceDayInternal(dayId, tx, context.today);
          }
          await this.evenOthers(tx, context, evened);
        },
      );
    }
    return this.plans.get(userId, locale, planId);
  }

  /** Change the settings of a day, on the plan as it was at the preview's `revision`. */
  async apply(
    userId: string,
    locale: Locale,
    planId: string,
    dayId: string,
    request: ApplyDaySettingsRequest,
    clientToday: string | null = null,
  ): Promise<MealPlan> {
    const context = await this.read(userId, planId, dayId, clientToday);
    if (context.plan.revision !== request.revision) {
      throw new ConflictException({
        error: 'PLAN_CHANGED',
        message: 'The plan changed while this request was running. Reload it and try again.',
      });
    }
    // A target of the day's own that the request changes is held to the least this body may be given.
    if (request.calorieTarget !== (parseDayOverrides(context.day.overrides)?.calorieTarget ?? null))
      refuseUnderLeast(
        request.calorieTarget,
        calculateCalories(calorieInputOf(context.profile)).leastTypedTarget,
        'calorieTarget',
      );
    let change = this.change(context, request);
    // The week evened out with the change: this day's target is the one an evened week gives it.
    const evened = request.evenWeek
      ? this.evened(context, this.weekAfter(context, change))
      : new Map<string, number>();
    const evenedTarget = evened.get(dayId);
    if (evenedTarget !== undefined && evenedTarget !== change.target)
      change = this.change(context, request, evenedTarget);
    const othersChange = context.week.some(
      (day) => day.id !== dayId && evened.has(day.id) && evened.get(day.id) !== day.calorieTarget,
    );
    if (change.unchanged && !othersChange) return this.plans.get(userId, locale, planId);
    const gone = change.fates
      .filter((fate) => fate.fate === 'removed' || fate.fate === 'redrawn')
      .map((fate) => fate.mealId);

    if (change.drawn.length === 0) {
      await writePlan(
        this.prisma,
        planId,
        request.revision,
        clientToday ?? this.plans.today(),
        'day-settings',
        async (tx) => {
          await tx.mealPlanDay.update({
            where: { id: dayId },
            data: { calorieTarget: change.target, overrides: asJson(change.overrides) },
          });
          if (gone.length > 0) await tx.plannedMeal.deleteMany({ where: { id: { in: gone } } });
          // The dishes that stay, brought to the day's target.
          if (change.resizes)
            await this.plans.rebalanceDayInternal(dayId, tx, clientToday ?? this.plans.today());
          await this.evenOthers(tx, context, evened);
          // What the day falls short of goes to the days after it, inside their windows.
          if (request.spreadShort)
            await this.plans.rebalanceRestInternal(
              planId,
              tx,
              context.date,
              clientToday ?? this.plans.today(),
            );
        },
      );
      return this.plans.get(userId, locale, planId);
    }

    // The day as a day made again sees it, with the meals that are pinned to it (eaten, and the user's own) kept.
    const prepared = await this.generation.prepare(
      userId,
      planId,
      { from: context.date, to: context.date },
      RegenerateDayRequest.parse({
        allowRelaxations: request.allowRelaxations,
        dropIneligibleLocks: true,
      }),
      clientToday,
    );
    const { dayIndex } = prepared.filled[0]!;
    const spec = prepared.days[dayIndex]!;
    const fateOf = new Map(change.fates.map((fate) => [fate.mealId, fate]));
    // The dishes that stay, and what each is to hold: where the day's target or number of meals changes, the
    // share of the day its meal has, of what is left after the meals that are pinned and the diary; otherwise what it holds now.
    const dishes = context.day.meals.filter(
      (meal) =>
        meal.recipe &&
        ['stays', 'resized'].includes(fateOf.get(meal.id)!.fate) &&
        fateOf.get(meal.id)!.because === null,
    );
    const pinned = context.day.meals.filter((meal) =>
      ['eaten', 'own'].includes(fateOf.get(meal.id)!.because ?? ''),
    );
    const room = Math.max(
      0,
      change.target -
        pinned.reduce((sum, meal) => sum + mealNutrition(meal).calories, 0) -
        (await toppingKcal(this.prisma, pinned)) -
        (prepared.diary.get(context.date)?.nutrition.calories ?? 0),
    );
    const budgets = slotBudgets(
      [...dishes.map((meal) => meal.mealType as MealType), ...change.drawn],
      room,
    );
    const portion = new Map(
      dishes.map((meal) => [
        meal.id,
        change.resizes
          ? fitServings(meal.recipe!.caloriesPerServing, budgets.get(meal.mealType as MealType)!)
          : meal.servings * meal.quantityScale,
      ]),
    );
    const keptDishes: KeptMeal[] = dishes.map((meal) => {
      const servings = portion.get(meal.id)!;
      const recipe = meal.recipe!;
      return {
        recipeId: meal.recipeId!,
        calories: recipe.caloriesPerServing * servings,
        servings,
        macros: {
          protein: recipe.proteinPerServing * servings,
          fat: recipe.fatPerServing * servings,
          carbs: recipe.carbsPerServing * servings,
        },
      };
    });
    spec.mealSlots = change.drawn;
    spec.calorieTarget = change.target;
    spec.cookTimeBudgetMinutes = request.cookTimeBudgetMinutes ?? undefined;
    spec.useUpBy = request.useUpBy;
    spec.skip = false;
    spec.overrides = change.overrides;
    spec.lockedSlots = (change.overrides?.lockedSlots ?? [])
      .filter((lock) => change.drawn.includes(lock.mealType))
      .map((lock) => ({ slot: lock.mealType, recipeId: lock.recipeId }));
    spec.kept = [...(spec.kept ?? []), ...keptDishes];

    const result = await this.generation.draw(userId, prepared, this.generation.nextSeed());
    const placed = result.assignments.filter((meal) => meal.dayIndex === dayIndex);
    const today = clientToday ?? this.plans.today();
    const cookedWith = request.together
      ? await this.plans.cookedWith(this.prisma, planId, PlanOptions.parse(prepared.plan.options))
      : new Map<string, CookedMeal[]>();
    const before = StoredReport.nullable().parse(prepared.plan.report ?? null);
    const report = before ? withDaysAgain(before, result.report, [context.date]) : null;
    await writePlan(this.prisma, planId, request.revision, today, 'day-settings', async (tx) => {
      // A lock that could not enter the plan has left the overrides of the day in the draw.
      await tx.mealPlanDay.update({
        where: { id: dayId },
        data: { calorieTarget: change.target, overrides: asJson(spec.overrides) },
      });
      await tx.plannedMeal.deleteMany({ where: { id: { in: gone } } });
      // The servings stay the plan's portion, which a dish grows from at most twice: the change moves its scale.
      if (change.resizes) {
        for (const meal of dishes)
          await tx.plannedMeal.update({
            where: { id: meal.id },
            data: { quantityScale: portion.get(meal.id)! / meal.servings },
          });
      }
      await tx.plannedMeal.createMany({
        data: placed.map((meal) => ({
          dayId,
          recipeId: meal.recipeId,
          mealType: meal.slot,
          servings: meal.servings,
          // In a plan that wastes less, the portion its packs were closed with, and the rests of packs it finishes.
          ...(prepared.lessWaste ? { quantityScale: meal.quantityScale } : {}),
          ...(meal.rests ? { rests: meal.rests } : {}),
          ...(meal.plate ? { plate: plateAsJson(meal.plate) } : {}),
        })),
      });
      await tx.mealPlan.update({
        where: { id: planId },
        data: { reuseScore: result.ingredientReuseScore, ...(report ? { report } : {}) },
      });
      await this.plans.rebalanceDayInternal(dayId, tx, today);
      await this.plans.carryToOtherDays(
        tx,
        planId,
        cookedWith,
        change.fates
          .filter((fate) => fate.fate === 'redrawn')
          .flatMap((fate) => {
            const drawn = placed.find((meal) => meal.slot === fate.mealType);
            return drawn ? [{ mealId: fate.mealId, recipeId: drawn.recipeId }] : [];
          }),
        new Set([dayId]),
        today,
      );
      await this.evenOthers(tx, context, evened);
      if (request.spreadShort)
        await this.plans.rebalanceRestInternal(planId, tx, context.date, today);
    });
    return this.plans.get(userId, locale, planId);
  }

  /**
   * The plan, the day, the profile and the week of the day, when the plan is
   * this user's; a day before today is refused, unless `pastAllowed`.
   */
  private async read(
    userId: string,
    planId: string,
    dayId: string,
    clientToday: string | null,
    { pastAllowed = false } = {},
  ) {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: {
        profile: true,
        days: {
          orderBy: { date: 'asc' },
          select: {
            id: true,
            date: true,
            calorieTarget: true,
            overrides: true,
            meals: { select: { eatenAt: true, source: true } },
          },
        },
      },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const index = plan.days.findIndex((one) => one.id === dayId);
    const found =
      index < 0
        ? null
        : await this.prisma.mealPlanDay.findUnique({
            where: { id: dayId },
            include: { meals: { include: { recipe: RECIPE } } },
          });
    if (!found)
      throw new NotFoundException({ error: 'DAY_NOT_FOUND', message: 'Plan day not found.' });
    // What the day's meals come to counts their pots' eggs and tortillas whole.
    const [day] = piecedDays(
      [found],
      await pieceUsesOf(
        this.prisma,
        found.meals.map((meal) => meal.id),
      ),
    );
    const date = isoDate(day.date);
    const today = clientToday ?? this.plans.today();
    // Dates in this form compare as text.
    if (!pastAllowed && date < today) {
      throw new ConflictException({
        error: 'DAY_IN_THE_PAST',
        message: 'This day is over: its settings stay as they were.',
      });
    }
    const week: WeekPlanDay[] = weeksOfPlan(plan.days)[weekOfDay(index)]!.map((one) => ({
      id: one.id,
      date: isoDate(one.date),
      calorieTarget: one.calorieTarget,
      overrides: one.overrides,
      eaten: one.meals.length > 0 && one.meals.every((meal) => meal.eatenAt !== null),
    }));
    return { plan, profile: plan.profile, day, date, week, today };
  }

  /**
   * What `settings` would do to the day; with `evenedTarget`, the target an
   * evened week gives it in place of the one the change alone gives.
   */
  private change(context: Context, settings: DaySettings, evenedTarget?: number): Change {
    const { plan, profile, day } = context;
    const before = parseDayOverrides(day.overrides);
    const count = dayMealCount(day, planMealCount(plan), profile.mealCount);
    // Another number of meals sets the meals the day has; the same number leaves them as they are.
    const slots: readonly MealType[] | null =
      settings.mealCount === count ? null : MEAL_SLOTS_BY_COUNT[settings.mealCount]!;
    const locks = (before?.lockedSlots ?? []).filter(
      (lock) => !slots || slots.includes(lock.mealType),
    );
    const overrides = compact({
      mealCount: slots ? settings.mealCount : before?.mealCount,
      calorieTarget: settings.calorieTarget ?? undefined,
      dayType: settings.dayType === 'normal' ? undefined : settings.dayType,
      skip: settings.skip || undefined,
      cookTimeBudgetMinutes: settings.cookTimeBudgetMinutes ?? undefined,
      useUpBy: settings.useUpBy || undefined,
      lockedSlots: locks.length > 0 ? locks : undefined,
    });
    // The day keeps its target while its kind and own target stay; another takes the level of its week.
    const kept =
      (before?.dayType ?? 'normal') === (overrides?.dayType ?? 'normal') &&
      (before?.calorieTarget ?? null) === (overrides?.calorieTarget ?? null) &&
      (before?.skip ?? false) === (overrides?.skip ?? false);
    const target =
      evenedTarget ??
      (kept
        ? day.calorieTarget
        : this.generation.targetOfDay(profile, plan, overrides, usualScale(context, overrides)));
    const targetChanged = target !== day.calorieTarget;
    // A limit draws other recipes when it is new or tighter, not every time the day is saved with it.
    const cookLimit =
      settings.cookTimeBudgetMinutes !== null &&
      settings.cookTimeBudgetMinutes !== (before?.cookTimeBudgetMinutes ?? null)
        ? settings.cookTimeBudgetMinutes
        : null;
    const useUp = settings.useUpBy && before?.useUpBy !== true;
    // A dish the user locked to its meal stays there whatever limit comes.
    const locked = (meal: DayMeal): boolean =>
      (before?.lockedSlots ?? []).some(
        (lock) => lock.mealType === meal.mealType && lock.recipeId === meal.recipeId,
      );
    const resizes = !settings.skip && (targetChanged || slots !== null);

    const meals = [...day.meals].sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType));
    const fates = meals.map((meal): DayMealFate => {
      const fate = (
        to: DayMealFate['fate'],
        because: DayMealFate['because'] = null,
      ): DayMealFate => ({
        mealId: meal.id,
        mealType: meal.mealType as MealType,
        fate: to,
        because,
        portion: null,
      });
      if (meal.eatenAt) return fate('stays', 'eaten');
      if (settings.skip) return fate('removed', 'skipped');
      if (meal.source === 'USER_CUSTOM' || !meal.recipe) return fate('stays', 'own');
      // A leftover is food there is: it keeps its portion, and goes only with its time of day.
      if (meal.leftoverFromDate)
        return slots && !slots.includes(meal.mealType as MealType)
          ? fate('removed', 'fewer_meals')
          : fate('stays', 'leftover');
      if (slots && !slots.includes(meal.mealType as MealType))
        return fate('removed', 'fewer_meals');
      if (
        !locked(meal) &&
        cookLimit !== null &&
        meal.recipe.prepMinutes + meal.recipe.cookMinutes > cookLimit
      )
        return fate('redrawn', 'over_cook_time');
      if (!locked(meal) && useUp) return fate('redrawn', 'use_up');
      return fate(resizes ? 'resized' : 'stays');
    });

    // The meals the day keeps hold their times of day as a day made again holds them (`heldTimes`); a day that is no
    // longer skipped gets the meals of its number again.
    const held = heldTimes(
      day.meals,
      day.meals.filter((meal) => fates.find((fate) => fate.mealId === meal.id)!.fate !== 'removed'),
    );
    const wanted = settings.skip
      ? []
      : (slots ?? (before?.skip === true ? MEAL_SLOTS_BY_COUNT[settings.mealCount]! : []));
    const added = wanted.filter((slot) => !held.has(slot));
    const drawn = [
      ...fates.filter((fate) => fate.fate === 'redrawn').map((fate) => fate.mealType),
      ...added,
    ].sort((a, b) => mealRank(a) - mealRank(b));
    const unchanged =
      !targetChanged &&
      added.length === 0 &&
      fates.every((fate) => fate.fate === 'stays') &&
      canonical(before) === canonical(overrides);
    return { overrides, target, fates, added, drawn, resizes, unchanged };
  }
}

/**
 * What a usual day of the day's week is against the plan's target, as the
 * other days of the week that share it hold it: a day changed alone takes the
 * level of its week, so that a training day stays as far over its usual days
 * as the others are. Where no other day shares the week, the scale its kinds
 * give it with the day's new settings.
 */
function usualScale(context: Context, overrides: DayOverridesJson | null): number {
  const others = context.week.filter(
    (one) => one.id !== context.day.id && sharesTheWeek(asWeekDay(one)),
  );
  if (others.length === 0)
    return weekScale(
      context.week.map((one) => asWeekDay(one.id === context.day.id ? { overrides } : one)),
    );
  const kinds = others.reduce(
    (sum, one) => sum + DAY_KIND_FACTOR[asWeekDay(one).dayType ?? 'normal'],
    0,
  );
  const held = others.reduce((sum, one) => sum + one.calorieTarget, 0);
  return held / (kinds * context.plan.calorieTarget);
}

/** The settings of a day as they are kept: only those that are set, and none when none is. */
function compact(overrides: DayOverridesJson): DayOverridesJson | null {
  const set = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as DayOverridesJson;
  return Object.keys(set).length > 0 ? set : null;
}

/** Overrides in one form whatever order their keys were written in, to compare. */
function canonical(overrides: DayOverridesJson | null): string {
  return overrides
    ? JSON.stringify(
        Object.keys(overrides)
          .sort()
          .map((key) => [key, overrides[key as keyof DayOverridesJson]]),
      )
    : 'null';
}

const asJson = (overrides: DayOverridesJson | null) =>
  overrides ? (overrides as Prisma.InputJsonValue) : Prisma.JsonNull;

/** A number to the hundredth, as a portion is said. */
const hundredths = (value: number): number => Math.round(value * 100) / 100;
