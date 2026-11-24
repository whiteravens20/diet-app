// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  dayAfter,
  fitsDiet,
  FROZEN_KEEPS_DAYS,
  MAX_DIARY_ENTRIES_KEPT,
  MAX_MEALS_ON_A_PLAN_DAY,
  PlanOptions,
  TARGET_MOVED_LEAST_KCAL,
  type AddCustomMealRequest,
  type CookingChange,
  type DiaryEntry,
  type KeepFrozenRequest,
  type KeepLeftRequest,
  type Locale,
  type MealPlan,
  type MealPlanDay,
  type MealPlanPage,
  type MealPlanSummary,
  type MealType,
  type PlanListQuery,
  type PlannedMeal,
  type PlanPacks,
  type RebalanceChange,
  type RebalanceRequest,
  type RebalanceResult,
  type Sex,
  type UndoSwapRequest,
} from '@diet-app/shared';
import {
  estimatedMacros,
  fitServings,
  safetyFloor,
  macrosForCalories,
  shownTarget,
  rebalanceDays,
  REBALANCE_TOLERANCE,
  sizeDay,
  topAndSizeDay,
  plateDay,
  withPlates,
  type RebalanceMeal,
} from '../engine/index.js';
import { portionsOf, portionsUpTo } from '@diet-app/shared/portions';
import { SERVING_MAX, SERVING_MIN } from '../engine/optimizer.js';
import type { Env } from '../config/env.js';
import { kitchenFreezes, levelOf } from '../engine/waste-levels.js';
import {
  assertRoomInPantry,
  assertWithinCeiling,
  lockPantry,
  newParcels,
} from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toPlannedIngredients, toRecipeDto, type RecipeLine } from '../recipes/recipes.service.js';
import {
  toppingAskOfDay,
  toppingFiguresOf,
  toppingFoodsOf,
  type ToppingFoods,
} from './toppings-store.js';
import {
  cookingsOf,
  onDaysOf,
  packedMealsOf,
  planPacks,
  type FreezerNow,
  type FrozenRow,
  type PackedLine,
  type PackedMeal,
} from './plan-menu.js';
import {
  dateAfter,
  givesALeftover,
  leftoverDays,
  leftoverOfferOf,
  nextDayOf,
  nextDaysOf,
  type NextDay,
} from './leftovers.js';
import {
  freezerOf,
  oneFreezer,
  shownReport,
  StoredReport,
  withMealOutside,
  type Freezer,
} from './generation-report.js';
import { LINES_OF_KINDS, readPlanLimits } from './plan-limits.js';
import { writeOnce } from '../common/idempotency.js';
import { labelLimitsOf, type LabelLimitColumns } from '../common/label-limits.js';
import { labelNotes, roundLabel, sumLabels } from '../engine/label-totals.js';
import { energyShares } from '../engine/nutrition.js';
import { ingredientEaten, productEaten } from '../diary/chosen-food.js';
import {
  averageDay,
  dayAsItStands,
  customMacros,
  aimOfDay,
  dayMealCount,
  planMealCount,
  macrosOff,
  isoDate,
  isSkipped,
  MADE_LAST,
  mealLabel,
  mealNutrition,
  mealRank,
  parseDayOverrides,
  standingOf,
  sumNutrition,
  restsOf,
  restsAsJson,
  settleNewRecipes,
  plateOfMeal,
  plateShare,
  plateAsJson,
  sharesOfPlanDay,
  storedPlateOf,
  planSettingsOff,
  whyMacrosOff,
  type StoredPlate,
  type MealRow,
} from './plan-days.js';
import { plateDishesOf } from './plates-store.js';
import { planBaseOf, type BaseProfile } from './plan-base.js';
import { planWeeks } from './plan-weeks.js';
import {
  lockStockRows,
  releasePlanLists,
  settleHouseholds,
  TRANSACTION,
} from '../shopping-lists/shopping-lists.service.js';
import { diaryDays, diaryOfDays, diaryOfPlans, type DiaryOnDay } from '../diary/diary-days.js';
import { diaryMealOf, eatenMeals, entryOfEaten } from '../diary/eaten-meals.js';
import { holdProfile } from '../common/hold.js';
import { entriesOfDays } from '../diary/diary-entries.js';
import { planChangedMeanwhile, writePlan, writePlans } from './plan-write.js';
import {
  CANDIDATE,
  dislikedIn,
  restrictionsFor,
  violations,
  type Candidate,
  type Restrictions,
} from './eligibility.js';
import {
  pieceFactorOf,
  pieceUsesOf,
  piecedDays,
  keepPieces,
  selfContained,
  usesOfPlans,
  WHOLE_LINES,
  type PieceUses,
} from './whole-pieces-store.js';

/**
 * Reading a plan, and what changes a meal without choosing another recipe: a
 * meal of the user's own, what was eaten, the rebalance. Making a plan is
 * `PlanGenerationService`; swaps are `MealSwapService` and
 * `IngredientSwapService`.
 */
@Injectable()
export class MealPlansService {
  private readonly logger = new Logger('MealPlans');

  /** The server's own day, for a request that names none; replaceable in a test. */
  today: () => string = () => isoDate(new Date());

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Delete a plan and everything under it (days, meals, shopping lists cascade). What was eaten from it is
   * the person's and stays: each meal marked eaten is written into the diary as an entry of its day and
   * time of day, with the figures the day counted for it and named in the language of the request, so
   * that the day reads the same after the removal as before. A day those entries would take over
   * `MAX_DIARY_ENTRIES_KEPT` refuses the removal, 409 `PLAN_DIARY_FULL` with that day.
   */
  async remove(userId: string, locale: Locale, planId: string): Promise<void> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const profileId = plan.profile.id;
    const first = isoDate(plan.startDate);
    const last = dayAfter(first, plan.durationDays - 1);
    // The plan takes its shopping lists with it. What was obtained for the
    // days still ahead is in the kitchen and goes into the pantry first, by
    // the rule a list deleted on its own follows; a household list left with
    // one part is that plan's list alone.
    await this.prisma.$transaction(
      async (tx) => {
        // Counted while the profile is held, as an entry written into the diary is.
        await holdProfile(tx, profileId);
        const eaten = await eatenMeals(tx, profileId, new Date(first), new Date(last), {
          only: planId,
        });
        if (eaten.length > 0) {
          const dates = [...new Set(eaten.map((meal) => meal.date))];
          const held = new Map(
            (
              await tx.diaryEntry.groupBy({
                by: ['date'],
                where: { profileId, date: { in: dates.map((date) => new Date(date)) } },
                _count: true,
              })
            ).map((row) => [isoDate(row.date), row._count]),
          );
          const full = dates.find(
            (date) =>
              (held.get(date) ?? 0) + eaten.filter((meal) => meal.date === date).length >
              MAX_DIARY_ENTRIES_KEPT,
          );
          if (full)
            throw new ConflictException({
              error: 'PLAN_DIARY_FULL',
              message: `The diary of ${full} holds too many entries to keep what was eaten from the plan that day: remove an entry of it first.`,
              details: { date: full },
            });
          // The entries keep the order of the day: the first of them is the first written.
          const now = Date.now();
          await tx.diaryEntry.createMany({
            data: eaten.map((meal, index) => ({
              ...entryOfEaten(meal, locale),
              profileId,
              date: new Date(meal.date),
              createdAt: new Date(now + index),
            })),
          });
        }
        const households = await releasePlanLists(tx, planId, profileId);
        // A plan made together with another leaves it a plan of its own, whose shared meals are its own again.
        if (plan.jointPlanId) await tx.jointPlan.deleteMany({ where: { id: plan.jointPlanId } });
        await tx.mealPlan.deleteMany({ where: { id: planId } });
        await settleHouseholds(tx, households);
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  /**
   * A page of the plans of a profile, the one that begins last first, each
   * as a summary. The list is narrowed in the database, so that a page is all
   * that is ever read: a plan's days and meals are loaded only as far as its
   * average takes.
   */
  async list(
    userId: string,
    query: PlanListQuery,
    clientToday: string | null = null,
  ): Promise<MealPlanPage> {
    await this.loadProfile(userId, query.profileId);
    // The day it is for whoever asks; the server's own when the client named none.
    const today = clientToday ?? isoDate(new Date());

    // The last day of a plan is its first plus its length less one.
    const lastDay = Prisma.sql`("startDate" + ("durationDays" - 1))`;
    const day = (date: string) => Prisma.sql`${date}::date`;
    const narrowed = [
      Prisma.sql`"profileId" = ${query.profileId}`,
      ...(query.to ? [Prisma.sql`"startDate" <= ${day(query.to)}`] : []),
      ...(query.from ? [Prisma.sql`${lastDay} >= ${day(query.from)}`] : []),
      ...(query.status === 'active'
        ? [Prisma.sql`"startDate" <= ${day(today)} AND ${lastDay} >= ${day(today)}`]
        : []),
      ...(query.status === 'past' ? [Prisma.sql`${lastDay} < ${day(today)}`] : []),
      ...(query.status === 'upcoming' ? [Prisma.sql`"startDate" > ${day(today)}`] : []),
    ];
    const where = Prisma.join(narrowed, ' AND ');
    const [{ total }] = await this.prisma.$queryRaw<
      [{ total: number }]
    >`SELECT COUNT(*)::int AS total FROM "MealPlan" WHERE ${where}`;
    const page = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "MealPlan" WHERE ${where}
      ORDER BY "startDate" DESC, "createdAt" DESC, "id"
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;

    const amount = {
      caloriesPerServing: true,
      proteinPerServing: true,
      fatPerServing: true,
      carbsPerServing: true,
    } as const;
    const plans = await this.prisma.mealPlan.findMany({
      where: { id: { in: page.map((row) => row.id) } },
      include: {
        // The plan made together with it, where there is one: what the list says of it.
        joint: {
          select: {
            plans: { select: { id: true, profileId: true, profile: { select: { name: true } } } },
          },
        },
        days: {
          orderBy: { date: 'asc' },
          select: {
            date: true,
            overrides: true,
            meals: {
              select: {
                id: true,
                mealType: true,
                recipeId: true,
                servings: true,
                quantityScale: true,
                source: true,
                customMacros: true,
                rests: true,
                plate: true,
                modelPicked: true,
                wholePieces: true,
                keptPieces: true,
                sharedMealId: true,
                givenLeftoverId: true,
                leftoverFromDate: true,
                leftoverFromMealType: true,
                toppingKey: true,
                toppingAmount: true,
                recipe: { select: { ...amount, servings: true, ingredients: WHOLE_LINES } },
              },
            },
          },
        },
      },
    });
    const byId = new Map(plans.map((plan) => [plan.id, plan]));
    // The pots of a plan with every pot in it are worked out as it was read; the others read the plans they share with.
    const mealIdsOf = (of: readonly (typeof plans)[number][]) =>
      of.flatMap((plan) => plan.days.flatMap((day) => day.meals.map((meal) => meal.id)));
    const own = plans.filter((plan) => selfContained(plan));
    const sharing = plans.filter((plan) => !selfContained(plan));
    const pieces: PieceUses = new Map([
      ...usesOfPlans(own, mealIdsOf(own)),
      ...(sharing.length > 0 ? await pieceUsesOf(this.prisma, mealIdsOf(sharing)) : []),
    ]);
    // A day of a plan is summed as the plan shows it: with the toppings of its meals and what was eaten besides them.
    const [toppingFoods, diary] = await Promise.all([
      plans.some((plan) =>
        plan.days.some((day) => day.meals.some((meal) => meal.toppingKey !== null)),
      )
        ? toppingFoodsOf(this.prisma)
        : (new Map() as ToppingFoods),
      diaryOfPlans(this.prisma, query.profileId, plans),
    ]);
    return {
      items: page.flatMap(({ id }) => {
        const plan = byId.get(id);
        // Deleted between the two reads: it is on no page any more.
        return plan
          ? [this.toSummary(plan, pieces, toppingFoods, diary.get(plan.id) ?? new Map())]
          : [];
      }),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  /**
   * "Dodaj do spiżarni" of a rest of meat or fish the plan puts in the freezer (`KeepFrozenRequest`): what is left of
   * it once the plan is over goes into the profile's pantry in the freezer, in packages of their own none bigger than
   * the plan's portion of it (`PlanFrozenRest.portion`: a plan takes a package out only whole), split as evenly as
   * "Zamroź" splits, each dated `FROZEN_KEEPS_DAYS` from the day it went in, and the plan keeps that it gave it. A rest
   * given already changes nothing; one the plan no longer freezes, or eats whole, answers 409 `FROZEN_REST_GONE`, and
   * one it freezes on a later day 409 `REST_NOT_FROZEN_YET`: until then the pantry would hold what was not even bought,
   * and a shopping list would count it as at home.
   * The two plans of a joint plan share one kitchen and its rests: a rest goes into the pantry of the plan it was
   * given from, once, and both plans keep that it was given.
   */
  async keepFrozen(
    userId: string,
    locale: Locale,
    planId: string,
    asked: KeepFrozenRequest,
    clientToday: string | null = null,
  ): Promise<MealPlan> {
    const plan = await this.get(userId, locale, planId, clientToday);
    const rest = plan.packs.frozen.find(
      (one) => one.ingredientId === asked.ingredientId && one.date === asked.date,
    );
    if (!rest || rest.left < 1)
      throw new ConflictException({
        error: 'FROZEN_REST_GONE',
        message: 'The plan no longer puts this rest in the freezer, or eats all of it itself.',
      });
    if (rest.inPantry) return plan;
    if (rest.date > (clientToday ?? this.today()))
      throw new ConflictException({
        error: 'REST_NOT_FROZEN_YET',
        message: 'The plan puts this rest in the freezer on a later day.',
      });
    await this.prisma.$transaction(async (tx) => {
      // One at a time for a kitchen: the plans of a joint plan are held in one order, and the second finds the rest
      // given from either.
      const { jointPlanId } = await tx.mealPlan.findUniqueOrThrow({
        where: { id: planId },
        select: { jointPlanId: true },
      });
      await tx.$queryRaw(
        jointPlanId
          ? Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "jointPlanId" = ${jointPlanId} ORDER BY "id" FOR UPDATE`
          : Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "id" = ${planId} FOR UPDATE`,
      );
      const kitchen = await tx.mealPlan.findMany({
        where: jointPlanId ? { jointPlanId, profile: { userId } } : { id: planId },
        select: { id: true, profileId: true, frozenKept: true },
      });
      const given = (one: { frozenKept: unknown }) =>
        KeptFrozen.parse(one.frozenKept).some(
          (kept) => kept.ingredientId === rest.ingredientId && kept.date === rest.date,
        );
      if (kitchen.some(given)) return;
      const { profileId } = kitchen.find((one) => one.id === planId)!;
      await lockPantry(tx, profileId, rest.ingredientId);
      const bestBefore = new Date(dayAfter(rest.date, FROZEN_KEEPS_DAYS));
      // Packages of their own: nothing frozen adds to another.
      assertWithinCeiling(rest.left, rest.unit);
      const parts = portionsOf(rest.left, portionsUpTo(rest.left, rest.portion)) ?? [rest.left];
      await assertRoomInPantry(tx, profileId, parts.length);
      const parcels = await newParcels(tx, profileId, parts.length);
      await tx.inventoryItem.createMany({
        data: parts.map((quantity, at) => ({
          profileId,
          ingredientId: rest.ingredientId,
          unit: rest.unit,
          quantity,
          bestBefore,
          frozen: true,
          parcel: parcels[at]!,
        })),
      });
      for (const one of kitchen)
        await tx.mealPlan.update({
          where: { id: one.id },
          data: {
            frozenKept: [
              ...KeptFrozen.parse(one.frozenKept),
              { ingredientId: rest.ingredientId, date: rest.date, amount: rest.left },
            ] satisfies KeptFrozen,
          },
        });
    });
    return this.get(userId, locale, planId, clientToday);
  }

  /**
   * "Dodaj do spiżarni" of what a pack the menu opens leaves (`KeepLeftRequest`): it goes into the pantry as fresh
   * food, added to what is fresh of the food there, dated the pack's last day where that is sooner, once for the
   * kitchen. A pack the menu no longer leaves enough of (a spoonful, `PlanOpenPack.forThePantry`) answers 409
   * `PACK_LEFT_GONE`, and one it opens on a later day 409 `PACK_NOT_OPENED_YET`: until then the pantry would hold what
   * was not even bought, and a shopping list would count it as at home.
   */
  async keepLeft(
    userId: string,
    locale: Locale,
    planId: string,
    asked: KeepLeftRequest,
    clientToday: string | null = null,
  ): Promise<MealPlan> {
    const plan = await this.get(userId, locale, planId, clientToday);
    const pack = plan.packs.open.find(
      (one) => one.ingredientId === asked.ingredientId && one.date === asked.date,
    );
    if (!pack?.forThePantry)
      throw new ConflictException({
        error: 'PACK_LEFT_GONE',
        message: 'The plan no longer leaves enough of this pack to put into the pantry.',
      });
    if (pack.inPantry) return plan;
    if (pack.date > (clientToday ?? this.today()))
      throw new ConflictException({
        error: 'PACK_NOT_OPENED_YET',
        message: 'The plan opens this pack on a later day.',
      });
    await this.prisma.$transaction(async (tx) => {
      // One at a time for a kitchen: the plans of a joint plan are held in one order, and the second finds what
      // either gave.
      const { jointPlanId } = await tx.mealPlan.findUniqueOrThrow({
        where: { id: planId },
        select: { jointPlanId: true },
      });
      await tx.$queryRaw(
        jointPlanId
          ? Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "jointPlanId" = ${jointPlanId} ORDER BY "id" FOR UPDATE`
          : Prisma.sql`SELECT "id" FROM "MealPlan" WHERE "id" = ${planId} FOR UPDATE`,
      );
      const kitchen = await tx.mealPlan.findMany({
        where: jointPlanId ? { jointPlanId, profile: { userId } } : { id: planId },
        select: { id: true, profileId: true, packsKept: true },
      });
      const given = (one: { packsKept: unknown }) =>
        KeptLeft.parse(one.packsKept).some(
          (kept) => kept.ingredientId === pack.ingredientId && kept.date === pack.date,
        );
      if (kitchen.some(given)) return;
      const { profileId } = kitchen.find((one) => one.id === planId)!;
      // Rows of lists first, then the pantry: the order every writer takes its locks in.
      await lockStockRows(tx, profileId, pack.ingredientId);
      await lockPantry(tx, profileId, pack.ingredientId);
      const until = new Date(pack.until);
      const fresh = await tx.inventoryItem.findFirst({
        where: { profileId, ingredientId: pack.ingredientId, unit: pack.unit, frozen: false },
      });
      if (fresh) {
        assertWithinCeiling(fresh.quantity + pack.left, pack.unit);
        await tx.inventoryItem.update({
          where: { id: fresh.id },
          data: {
            quantity: fresh.quantity + pack.left,
            bestBefore: fresh.bestBefore && fresh.bestBefore < until ? fresh.bestBefore : until,
          },
        });
      } else {
        assertWithinCeiling(pack.left, pack.unit);
        await assertRoomInPantry(tx, profileId);
        await tx.inventoryItem.create({
          data: {
            profileId,
            ingredientId: pack.ingredientId,
            unit: pack.unit,
            quantity: pack.left,
            bestBefore: until,
          },
        });
      }
      for (const one of kitchen)
        await tx.mealPlan.update({
          where: { id: one.id },
          data: {
            packsKept: [
              ...KeptLeft.parse(one.packsKept),
              { ingredientId: pack.ingredientId, date: pack.date, amount: pack.left },
            ] satisfies KeptLeft,
          },
        });
    }, TRANSACTION);
    return this.get(userId, locale, planId, clientToday);
  }

  async get(
    userId: string,
    locale: Locale,
    planId: string,
    clientToday: string | null = null,
  ): Promise<MealPlan> {
    const mine = await this.assemble(userId, locale, planId, clientToday);
    const jointPlanId = mine.plan.jointPlanId;
    if (!jointPlanId) return mine.dto;
    // The plan made together with this one, while it is there: the meals at the same times are shared.
    const other = await this.prisma.mealPlan.findFirst({
      where: { jointPlanId, id: { not: planId }, profile: { userId } },
      select: { id: true },
    });
    if (!other) return mine.dto;
    const [theirs, sharedMeals] = await Promise.all([
      this.assemble(userId, locale, other.id, clientToday),
      this.prisma.sharedMeal.findMany({
        where: { jointPlanId },
        select: { id: true, apart: true },
      }),
    ]);
    return joined(mine, theirs, new Map(sharedMeals.map((meal) => [meal.id, meal.apart])), locale);
  }

  /** A plan as it is answered, of its own: what it shares with another plan is added by `get`. */
  private async assemble(
    userId: string,
    locale: Locale,
    planId: string,
    clientToday: string | null,
  ): Promise<Assembled> {
    const trWhere = locale === 'en' ? ['en'] : [locale, 'en'];
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: {
        days: {
          orderBy: { date: 'asc' },
          include: {
            meals: {
              include: {
                recipe: {
                  include: {
                    ingredients: {
                      orderBy: { position: 'asc' },
                      include: {
                        ingredient: {
                          include: { translations: { where: { locale: { in: trWhere } } } },
                        },
                      },
                    },
                    translations: { where: { locale: { in: trWhere } } },
                  },
                },
              },
            },
          },
        },
        profile: { include: { preferences: true } },
      },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const today = clientToday ?? this.today();
    // Where what is left of a meal of yesterday or today would go: the day after it, this plan's
    // where it holds that day, otherwise that of the plan made last that holds it, asked only
    // where a meal could give one. Where a plan made later holds the day too, the leftover goes
    // to that one, which the window asks before anything is put there.
    const { to } = leftoverDays(today);
    const ownNext = new Map(
      plan.days
        .filter((day) => to.includes(isoDate(day.date)))
        .map((day) => [isoDate(day.date), nextDayOf(day)] as const),
    );
    const elsewhere = to.filter(
      (date) =>
        !ownNext.has(date) &&
        plan.days.some(
          (day) =>
            dateAfter(isoDate(day.date)) === date &&
            day.meals.some((meal) => givesALeftover(meal, isoDate(day.date), today)),
        ),
    );
    const mealIds = plan.days.flatMap((day) => day.meals.map((meal) => meal.id));
    const [restrictions, diary, { lists, frozen }, nextElsewhere, toppingFoods, pieces] =
      await Promise.all([
        restrictionsFor(this.prisma, plan),
        diaryOfDays(this.prisma, plan.profileId, plan.days, plan.id),
        listsAndFreezerOf(this.prisma, planId, plan.profileId),
        elsewhere.length > 0
          ? nextDaysOf(this.prisma, plan.profileId, elsewhere)
          : new Map<string, NextDay>(),
        // The foods of the toppings, read only for a plan that has any.
        plan.days.some((day) => day.meals.some((meal) => meal.toppingKey !== null))
          ? toppingFoodsOf(this.prisma)
          : (new Map() as ToppingFoods),
        // A plan with every pot in it is worked out as it was read; one that shares a pot reads the other plan too.
        selfContained(plan) ? usesOfPlans([plan], mealIds) : pieceUsesOf(this.prisma, mealIds),
      ]);
    const freezerNow: FreezerNow = {
      rows: frozen,
      taken: parcelsOf(freezerOf(plan.report)),
      madeAt: plan.createdAt,
      today,
    };
    const nextDays = new Map([...nextElsewhere, ...ownNext]);
    // The entries themselves are read only for a plan whose days hold any.
    const written = [...diary.values()].some((day) => day.entries > 0)
      ? await entriesOfDays(this.prisma, locale, plan.profileId, plan.days)
      : new Map<string, DiaryEntry[]>();
    const packed = packedMealsOf(
      plan.days,
      PlanOptions.parse(plan.options).mealPrepFriendly,
      toppingFoods,
    );
    return {
      plan,
      dto: this.toDto(
        plan,
        locale,
        restrictions,
        diary,
        written,
        lists,
        today,
        nextDays,
        toppingFoods,
        packed,
        pieces,
        freezerNow,
      ),
      packed,
      pieces,
      freezerNow,
    };
  }

  /**
   * Add a user-authored custom meal to a day, beside its meals or in the place
   * of one (`replaces`), which then leaves the day. The macros are frozen on
   * the row as the user entered them — the engine never recomputes them, because
   * a custom meal has no ingredient list. Adding it changes the day total, so a
   * day rebalance runs immediately. Sent again with its key, the request is
   * answered with the plan as it is now, without a rebalance, and adds nothing.
   */
  addCustomMeal(
    userId: string,
    locale: Locale,
    planId: string,
    date: string,
    req: AddCustomMealRequest,
    key: string | null = null,
    clientToday: string | null = null,
  ): Promise<RebalanceResult> {
    return writeOnce(this.prisma, {
      userId,
      key,
      route: `POST /meal-plans/${planId}/days/${date}/custom-meal`,
      request: req,
      write: async (keep) => {
        const day = await this.loadDay(userId, planId, date);
        const meal = await this.ownMealOf(userId, locale, day, req);
        const overrides = parseDayOverrides(day.overrides);
        const summary = await writePlan(
          this.prisma,
          planId,
          day.plan.revision,
          clientToday ?? this.today(),
          async (tx) => {
            // Adding a meal to a previously-skipped day un-skips it (it now has content).
            if (overrides?.skip) {
              const rest: Record<string, unknown> = { ...(overrides as Record<string, unknown>) };
              delete rest.skip;
              await tx.mealPlanDay.update({
                where: { id: day.id },
                data: {
                  overrides:
                    Object.keys(rest).length > 0
                      ? (rest as Prisma.InputJsonValue)
                      : Prisma.JsonNull,
                },
              });
            }
            // The dish a recipe chosen in the place of a meal was chosen over: it was put there by hand.
            let swappedFrom: string | null = null;
            if (req.replaces) {
              const replaced = await tx.plannedMeal.findFirst({
                where: { id: req.replaces, dayId: day.id },
                select: { recipeId: true },
              });
              if (!replaced)
                throw new NotFoundException({
                  error: 'MEAL_NOT_FOUND',
                  message: 'Planned meal not found.',
                });
              await tx.plannedMeal.delete({ where: { id: req.replaces } });
              swappedFrom = replaced.recipeId;
            }
            // Counted once a meal it replaces has left the day.
            if (
              (await tx.plannedMeal.count({ where: { dayId: day.id } })) >= MAX_MEALS_ON_A_PLAN_DAY
            ) {
              throw new ConflictException({
                error: 'PLAN_DAY_FULL',
                message: `A day of a plan holds at most ${MAX_MEALS_ON_A_PLAN_DAY} meals: remove one first.`,
              });
            }
            await tx.plannedMeal.create({
              data: {
                dayId: day.id,
                mealType: req.mealType,
                quantityScale: 1,
                ...meal,
                ...(meal.recipeId && swappedFrom ? { swapHistory: [swappedFrom] } : {}),
              },
            });
            await keep(tx, planId);
            return this.rebalanceDayInternal(day.id, tx, clientToday ?? this.today());
          },
        );
        return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
      },
      replay: (id) => this.buildRebalanceResult(userId, locale, id, 'day', null),
    });
  }

  /**
   * What a meal of one's own added to a day is, as its row holds it: a recipe chosen (`of`) as that recipe, in its
   * servings; a product or an ingredient chosen as a meal of one's own with the name and figures the diary works out
   * for an entry of it; or a meal typed by hand, by its figures, the macronutrients left out estimated in the
   * proportions of the day's target.
   */
  private async ownMealOf(
    userId: string,
    locale: Locale,
    day: { calorieTarget: number; plan: { dietType: string; macroSplit: unknown } },
    req: AddCustomMealRequest,
  ): Promise<
    Pick<
      Prisma.PlannedMealUncheckedCreateInput,
      'recipeId' | 'servings' | 'source' | 'customName' | 'customMacros' | 'estimated'
    >
  > {
    const of = req.of;
    if (of?.kind === 'recipe') {
      // A recipe of the library, or one of the account's own, as the recipe's page finds it.
      const recipe = await this.prisma.recipe.findFirst({
        where: {
          id: of.recipeId,
          deletedAt: null,
          OR: [{ createdByUserId: null }, { createdByUserId: userId }],
        },
        select: { id: true },
      });
      if (!recipe)
        throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
      return {
        recipeId: recipe.id,
        servings: of.servings,
        source: 'CATALOGUE',
        customName: null,
        estimated: false,
      };
    }
    if (of) {
      const eaten =
        of.kind === 'ingredient'
          ? await ingredientEaten(this.prisma, locale, of.ingredientId, of.amount)
          : await productEaten(
              this.prisma,
              userId,
              of.productId,
              of.quantity,
              sharesOfPlanDay(day.plan, day.calorieTarget),
            );
      const { calories, protein, fat, carbs } = eaten.figures;
      return {
        recipeId: null,
        servings: 1,
        source: 'USER_CUSTOM',
        customName: eaten.name,
        customMacros: { calories, protein, fat, carbs },
        estimated: 'estimated' in eaten.figures && eaten.figures.estimated,
      };
    }
    const { calories, ...known } = req.nutrition!;
    const given = Object.values(known).filter((value) => value !== undefined);
    if (![calories, ...given].every((v) => Number.isFinite(v) && v >= 0)) {
      throw new BadRequestException({
        error: 'CUSTOM_MEAL_INVALID_MACROS',
        message: 'Custom meal macros must be non-negative numbers.',
      });
    }
    // What is typed stands as it is; only what is left out is worked out.
    const estimated = given.length < 3;
    const macros = estimated
      ? estimatedMacros(calories, known, sharesOfPlanDay(day.plan, day.calorieTarget))
      : { protein: known.protein!, fat: known.fat!, carbs: known.carbs! };
    if (!macros) {
      throw new BadRequestException({
        error: 'DIARY_MACROS_OVER_ENERGY',
        message:
          'The protein, fat and carbohydrate given hold more energy than the calories given.',
      });
    }
    return {
      recipeId: null,
      servings: req.servings,
      source: 'USER_CUSTOM',
      customName: req.name!,
      customMacros: { calories, ...macros },
      estimated,
    };
  }

  /**
   * Take a meal off its day, whichever it is: one of the catalogue, the user's
   * own, eaten or not. The day has less in it then, so a day rebalance runs
   * immediately, as it does when a meal is added.
   */
  async removeMeal(
    userId: string,
    locale: Locale,
    planId: string,
    mealId: string,
    clientToday: string | null = null,
    forAll = false,
  ): Promise<RebalanceResult> {
    const meal = await this.loadPlannedMeal(userId, planId, mealId);
    const today = clientToday ?? this.today();
    // For both: the other person's meal of a shared meal leaves their day too, unless they have eaten it.
    const theirs = forAll ? await this.otherOfShared(userId, meal) : null;
    const other = theirs && theirs.eatenAt === null ? theirs : null;
    const summary = await writePlans(
      this.prisma,
      [
        { planId, revision: meal.day.plan.revision },
        ...(other ? [{ planId: other.day.planId, revision: other.day.plan.revision }] : []),
      ],
      today,
      async (tx) => {
        if (other) {
          await tx.plannedMeal.delete({ where: { id: other.id } });
          await this.rebalanceDayInternal(other.dayId, tx, today);
        }
        await tx.plannedMeal.delete({ where: { id: mealId } });
        return this.rebalanceDayInternal(meal.dayId, tx, today);
      },
    );
    if (meal.eatenAt !== null)
      await this.followEatenElsewhere(
        userId,
        meal.day.plan.profileId,
        isoDate(meal.day.date),
        planId,
        today,
      );
    return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
  }

  /**
   * Mark a planned meal eaten or not eaten. An eaten meal is pinned out of the
   * rebalance set (scaling an already-eaten portion is meaningless), so the day
   * is rebalanced after a change to redistribute among the rest. Asking for the
   * state the meal is already in changes nothing, so a repeated request is safe.
   */
  async setEaten(
    userId: string,
    locale: Locale,
    planId: string,
    mealId: string,
    eaten: boolean,
    clientToday: string | null = null,
    forAll = false,
  ): Promise<RebalanceResult> {
    const meal = await this.loadPlannedMeal(userId, planId, mealId);
    // "We ate": the other person's meal of a shared meal is marked with this one, where it is not already.
    const theirs = forAll ? await this.otherOfShared(userId, meal) : null;
    const other = theirs && (theirs.eatenAt !== null) !== eaten ? theirs : null;
    if ((meal.eatenAt !== null) === eaten && !other) {
      return this.buildRebalanceResult(userId, locale, planId, 'day', null);
    }
    const today = clientToday ?? this.today();
    // A day still to come is not eaten yet, as the diary holds no day ahead. Dates in this form compare as text.
    if (eaten && isoDate(meal.day.date) > today) {
      throw new ConflictException({
        error: 'MEAL_NOT_EATEN_YET',
        message: 'A meal of a day still to come cannot be marked as eaten.',
      });
    }
    const summary = await writePlans(
      this.prisma,
      [
        { planId, revision: meal.day.plan.revision },
        ...(other ? [{ planId: other.day.planId, revision: other.day.plan.revision }] : []),
      ],
      today,
      async (tx) => {
        const at = eaten ? new Date() : null;
        // What a meal is eaten with is kept as the person saw it, before any day around it is sized again.
        if (other) {
          await tx.plannedMeal.update({ where: { id: other.id }, data: { eatenAt: at } });
          await keepPieces(tx, [other.id]);
          await this.rebalanceDayInternal(other.dayId, tx, today);
        }
        if ((meal.eatenAt !== null) === eaten) return null;
        await tx.plannedMeal.update({ where: { id: mealId }, data: { eatenAt: at } });
        await keepPieces(tx, [mealId]);
        return this.rebalanceDayInternal(meal.dayId, tx, today);
      },
    );
    if ((meal.eatenAt !== null) !== eaten)
      await this.followEatenElsewhere(
        userId,
        meal.day.plan.profileId,
        isoDate(meal.day.date),
        planId,
        today,
      );
    if (other)
      await this.followEatenElsewhere(
        userId,
        other.day.plan.profileId,
        isoDate(other.day.date),
        other.day.planId,
        today,
      );
    return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
  }

  /**
   * What a change of what was eaten in one plan does to the day of the plan made last that holds it, where that is
   * another plan of the profile: a day of today is sized again, as a change of the diary sizes it, since what any of
   * the profile's plans had eaten counts as eaten on it. A change of that plan at the same moment is waited out once;
   * a day that cannot be sized now is left to its own "Dopasuj porcje dnia". Nothing for another day, or where the
   * plan changed is the one made last.
   */
  private async followEatenElsewhere(
    userId: string,
    profileId: string,
    date: string,
    planId: string,
    today: string,
  ): Promise<void> {
    if (date !== today) return;
    const shown = await this.prisma.mealPlanDay.findFirst({
      where: { date: new Date(date), plan: { profileId } },
      orderBy: [...MADE_LAST],
      select: { planId: true },
    });
    if (!shown || shown.planId === planId) return;
    const resize = () => this.resizeDay(userId, shown.planId, date, today);
    try {
      await resize().catch((err: unknown) => {
        if (err instanceof ConflictException && planChangedMeanwhile(err)) return resize();
        throw err;
      });
    } catch (err) {
      this.logger.warn(
        `Could not size the day of plan ${shown.planId} to what was eaten: ${String(err)}`,
      );
    }
  }

  /**
   * The other person's meal of a shared meal, of the other plan of the joint
   * plan, with its day and that plan's revision; null for a meal of one plan
   * alone, and where the other meal no longer holds the same dish.
   */
  async otherOfShared(
    userId: string,
    meal: { id: string; sharedMealId: string | null; recipeId: string | null },
  ) {
    if (!meal.sharedMealId) return null;
    const other = await this.prisma.plannedMeal.findFirst({
      where: {
        sharedMealId: meal.sharedMealId,
        id: { not: meal.id },
        day: { plan: { profile: { userId } } },
      },
      include: { day: { include: { plan: { select: { revision: true, profileId: true } } } } },
    });
    return other && other.recipeId === meal.recipeId ? other : null;
  }

  /**
   * The other person's meals linked to `meals` as shared meals, holding the
   * same dish, as a change of a dish carries one to a meal: the meals a change
   * asked for both takes to the other plan.
   */
  async partnersOf(userId: string, meals: readonly { id: string }[]): Promise<CookedMeal[]> {
    if (meals.length === 0) return [];
    const mine = await this.prisma.plannedMeal.findMany({
      where: { id: { in: meals.map((meal) => meal.id) }, sharedMealId: { not: null } },
      select: { id: true, recipeId: true, sharedMealId: true },
    });
    const theirs = await this.prisma.plannedMeal.findMany({
      where: {
        sharedMealId: { in: mine.map((meal) => meal.sharedMealId!) },
        id: { notIn: mine.map((meal) => meal.id) },
        day: { plan: { profile: { userId } } },
      },
      include: { recipe: { select: { caloriesPerServing: true } }, day: true },
    });
    const days = await this.prisma.mealPlanDay.findMany({
      where: { planId: { in: [...new Set(theirs.map((meal) => meal.day.planId))] } },
      orderBy: { date: 'asc' },
      select: { id: true },
    });
    const dayIndex = new Map(days.map((day, index) => [day.id, index]));
    return theirs
      .filter((meal) =>
        mine.some(
          (one) => one.sharedMealId === meal.sharedMealId && one.recipeId === meal.recipeId,
        ),
      )
      .map((meal) => ({
        id: meal.id,
        dayId: meal.dayId,
        dayIndex: dayIndex.get(meal.dayId) ?? 0,
        date: isoDate(meal.day.date),
        mealType: meal.mealType as MealType,
        recipeId: meal.recipeId!,
        eaten: meal.eatenAt !== null,
        skipped: isSkipped(meal.day),
        swapHistory: meal.swapHistory ?? [],
        held: (meal.recipe?.caloriesPerServing ?? 0) * meal.servings * meal.quantityScale,
      }));
  }

  /**
   * Say how a shared meal of the plan is cooked: each portion apart, or in one
   * pot split by weight. It is the same for both plans of the joint plan, and
   * changes none of their meals.
   */
  async setSharedMeal(
    userId: string,
    locale: Locale,
    planId: string,
    sharedMealId: string,
    apart: boolean,
  ): Promise<MealPlan> {
    await this.planOf(userId, planId);
    const updated = await this.prisma.sharedMeal.updateMany({
      where: { id: sharedMealId, joint: { plans: { some: { id: planId } } } },
      data: { apart },
    });
    if (updated.count !== 1)
      throw new NotFoundException({
        error: 'MEAL_NOT_FOUND',
        message: 'The plan shares no such meal.',
      });
    return this.get(userId, locale, planId);
  }

  /**
   * Explicit rebalance. `day` rebalances one date; `plan` shares the
   * surplus/deficit across the days from that date to the end of the plan.
   * `restore` is the undo path: it writes the supplied scales verbatim (the
   * toast's pre-edit `before` map) and skips the solver.
   */
  async rebalance(
    userId: string,
    locale: Locale,
    planId: string,
    req: RebalanceRequest,
    clientToday: string | null = null,
  ): Promise<RebalanceResult> {
    // Authorise the plan up front, and note the revision the request starts from.
    const { revision } = await this.planOf(userId, planId);

    const restore = req.restore;
    if (restore && restore.length > 0) {
      await writePlan(this.prisma, planId, revision, clientToday ?? this.today(), (tx) =>
        this.restoreScales(planId, restore, tx),
      );
      return this.buildRebalanceResult(userId, locale, planId, req.scope, null);
    }

    if (req.scope === 'plan') {
      const today = clientToday ?? this.today();
      const summary = await writePlan(
        this.prisma,
        planId,
        revision,
        clientToday ?? this.today(),
        (tx) => this.rebalanceRestInternal(planId, tx, req.date ?? today, today),
      );
      return this.buildRebalanceResult(userId, locale, planId, 'plan', summary);
    }

    // The contract refuses a single day without its date before it gets here.
    const day = await this.loadDay(userId, planId, req.date!);
    const summary = await writePlan(
      this.prisma,
      planId,
      revision,
      clientToday ?? this.today(),
      (tx) => this.rebalanceDayInternal(day.id, tx, clientToday ?? this.today()),
    );
    return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
  }

  /**
   * Sizes one day of a plan again, as a change of the plan does (`rebalanceDayInternal`), and answers what it did
   * without the plan read back: what a removal from the diary of that day asks of it (`DiaryService`).
   */
  async resizeDay(
    userId: string,
    planId: string,
    date: string,
    clientToday: string | null = null,
  ): Promise<RebalanceSummary | null> {
    const { revision } = await this.planOf(userId, planId);
    const day = await this.loadDay(userId, planId, date);
    return writePlan(this.prisma, planId, revision, clientToday ?? this.today(), (tx) =>
      this.rebalanceDayInternal(day.id, tx, clientToday ?? this.today()),
    );
  }

  /**
   * The profile, when it is this user's; otherwise the refusal every route
   * that names a profile gives. Here and in every loader like it, something
   * that is somebody else's is answered as something that is not there: the
   * same 404, so that nobody learns which ids exist.
   */
  async loadProfile(userId: string, profileId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      include: { preferences: true },
    });
    if (!profile || profile.userId !== userId)
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    return profile;
  }

  /*
   * A note for every loader below and its like in the other services: Prisma
   * fetches an included relation with a query of its own. When a plan is
   * deleted between two of those queries, a row comes back with a relation the
   * types call required set to null. Such a row is on its way out, so the
   * loaders treat a missing relation as "not found".
   */
  /** A meal of a plan, when the plan is this user's, with its day, plan and profile. */
  async loadPlannedMeal(userId: string, planId: string, plannedMealId: string) {
    const meal = await this.prisma.plannedMeal.findUnique({
      where: { id: plannedMealId },
      include: {
        day: { include: { plan: { include: { profile: { include: { preferences: true } } } } } },
      },
    });
    if (
      !meal?.day?.plan?.profile ||
      meal.day.planId !== planId ||
      meal.day.plan.profile.userId !== userId
    ) {
      throw new NotFoundException({ error: 'MEAL_NOT_FOUND', message: 'Planned meal not found.' });
    }
    return meal;
  }

  /** Load + authorise a plan day by ISO date. */
  /** The revision of a plan that is `userId`'s: enough to authorise an edit and to start it. */
  private async planOf(userId: string, planId: string): Promise<{ revision: number }> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      select: { revision: true, profile: { select: { userId: true } } },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    return { revision: plan.revision };
  }

  private async loadDay(userId: string, planId: string, date: string) {
    const day = await this.prisma.mealPlanDay.findFirst({
      where: { planId, date: new Date(date) },
      include: { plan: { include: { profile: true } } },
    });
    if (!day?.plan?.profile || day.plan.profile.userId !== userId) {
      throw new NotFoundException({ error: 'DAY_NOT_FOUND', message: 'Plan day not found.' });
    }
    return day;
  }

  /** The id of the day `date` of a plan that is `userId`'s. */
  async dayIdOf(userId: string, planId: string, date: string): Promise<string> {
    return (await this.loadDay(userId, planId, date)).id;
  }

  /**
   * Size one day's unchecked, non-custom meals for its target and its macros
   * and persist the new quantity scales. What the profile's diary holds for the
   * day counts as eaten, as an eaten meal does. Returns the summary the UI
   * toast renders, or null when the day has vanished or is skipped, which has
   * no target to keep to, or has passed: what was on it is a record, and no
   * edit of it changes the portions of the rest. Runs inside the transaction
   * of the edit that changed the day, whichever service made it.
   */
  async rebalanceDayInternal(
    dayId: string,
    tx: Prisma.TransactionClient,
    today: string,
    /** Of a day of a joint plan, the topping a model named for a meal, the one that meal may then be given. */
    named: ReadonlyMap<string, string> = new Map(),
  ): Promise<RebalanceSummary | null> {
    const day = await tx.mealPlanDay.findUnique({
      where: { id: dayId },
      include: {
        plan: {
          select: {
            profileId: true,
            dietType: true,
            macroSplit: true,
            calorieTarget: true,
            jointPlanId: true,
          },
        },
        meals: { include: { recipe: { select: REBALANCE_MACRO_SELECT } } },
      },
    });
    if (!day?.plan || isSkipped(day) || isoDate(day.date) < today) return null;
    const rows = day.meals.map(toRebalanceRow);
    const diary = await diaryDays(tx, day.plan.profileId, day.date, day.date, day.planId);
    const counted = [
      ...rows,
      ...restRebalanceRows(day.meals),
      ...diaryRows(diary.get(isoDate(day.date))),
    ];
    if (day.plan.jointPlanId === null) {
      const macrosBefore = rowsMacros(counted, (r) => r.quantityScale);
      const { scales, feasibility } = sizeDay(
        counted.map(toEngineMeal),
        day.calorieTarget,
        aimOfDay(day, day.plan),
      );
      const changes = await this.persistScales(rows, scales, tx);
      const macrosAfter = rowsMacros(counted, (r) => scales.get(r.id) ?? r.quantityScale);
      return { feasibility, changes, macrosBefore, macrosAfter };
    }

    // A day of a joint plan: the plates of its shared meals not eaten are chosen again (`plateDay`), and their
    // toppings put on again as the day is sized (`topAndSizeDay`). A plate or a topping eaten with its meal counts
    // and stays, and a leftover keeps the plate it was cooked on; one on a meal that is no longer a place for it
    // goes: a meal eaten apart, or one whose dish the other plan's meal no longer holds, which the end of the
    // write unlinks.
    const linked = day.meals.filter((m) => m.sharedMealId !== null && m.recipeId !== null);
    const partners = linked.length
      ? await tx.sharedMeal.findMany({
          where: { id: { in: linked.map((m) => m.sharedMealId!) } },
          select: { id: true, meals: { select: { recipeId: true } } },
        })
      : [];
    const oneDish = new Set(
      partners
        .filter(
          (shared) =>
            shared.meals.length === 2 && shared.meals[0]!.recipeId === shared.meals[1]!.recipeId,
        )
        .map((shared) => shared.id),
    );
    // In the order they are eaten, as a run of the planner takes them: the rows come in no order of their own, and
    // a topping that brings the day as near on two plates goes on the first, wherever it was before a change.
    const places = linked
      .filter(
        (m) =>
          oneDish.has(m.sharedMealId!) &&
          m.eatenAt === null &&
          m.leftoverFromDate === null &&
          m.source === 'CATALOGUE',
      )
      .sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType));
    const ask = await toppingAskOfDay(
      tx,
      { id: day.planId, profileId: day.plan.profileId, dietType: day.plan.dietType },
      day.date,
      places.map((m) => m.recipeId!),
    );
    // The meals not eaten yet, whose plates are chosen here: those of the places, if they are served on a plate.
    const open = day.meals.filter((m) => m.eatenAt === null && m.leftoverFromDate === null);
    const dishes = await plateDishesOf(
      tx,
      places.map((m) => m.recipeId!),
    );
    const plating = places.flatMap((m) => {
      const dish = dishes.get(m.recipeId!);
      return dish ? [{ mealId: m.id, dish, now: plateOfMeal(m.plate) }] : [];
    });
    /** The day's rows, those of the open meals with the plates given (none for any other). */
    const rowsWith = (plates: ReadonlyMap<string, StoredPlate>): RebalanceRow[] => [
      ...day.meals.map((m) =>
        open.includes(m)
          ? toRebalanceRow({ ...m, plate: plates.get(m.id) ?? null })
          : toRebalanceRow(m),
      ),
      ...restRebalanceRows(day.meals),
      ...diaryRows(diary.get(isoDate(day.date))),
    ];
    const per100Of = new Map(ask.options.map((option) => [option.topping.key, option.per100]));
    const mealTypeOf = new Map(day.meals.map((m) => [m.id, m.mealType]));
    const toppingRows = (
      of: readonly { mealId: string; key: string | null; amount: number | null }[],
    ) =>
      of.flatMap(({ mealId, key, amount }) => {
        const per100 = key !== null && amount !== null ? per100Of.get(key) : undefined;
        return per100
          ? [toppingRebalanceRow(mealId, mealTypeOf.get(mealId)!, per100, amount!)]
          : [];
      });
    const stays = toppingRows(
      day.meals
        .filter((m) => m.eatenAt !== null)
        .map((m) => ({ mealId: m.id, key: m.toppingKey, amount: m.toppingAmount })),
    );
    const macrosBefore = rowsMacros(
      [
        ...counted,
        ...toppingRows(
          day.meals.map((m) => ({ mealId: m.id, key: m.toppingKey, amount: m.toppingAmount })),
        ),
      ],
      (r) => r.quantityScale,
    );
    const aim = aimOfDay(day, day.plan);
    const bare = [...rowsWith(new Map()), ...stays].map(toEngineMeal);
    const plates = plateDay(bare, new Map(), plating, aim, day.plan.dietType);
    const platingOf = new Map(plating.map((place) => [place.mealId, place]));
    const storedPlates = new Map(
      [...plates].map(([mealId, plate]) => [
        mealId,
        storedPlateOf(platingOf.get(mealId)!.dish, plate),
      ]),
    );
    const { scales, toppings } = topAndSizeDay(
      withPlates(bare, plates, platingOf),
      day.calorieTarget,
      aim,
      places.flatMap((m) => {
        const dish = ask.traits.get(m.recipeId!);
        const only = named.get(m.id);
        return dish
          ? [{ mealId: m.id, meal: m.mealType as MealType, dish, ...(only ? { only } : {}) }]
          : [];
      }),
      ask.options,
      ask.eater,
      ask.used,
    );
    const changes = await this.persistScales(rows, scales, tx);
    for (const m of day.meals) {
      if (m.eatenAt !== null) continue;
      const chosen = toppings.find((choice) => choice.mealId === m.id);
      const key = chosen?.key ?? null;
      const amount = chosen?.amount ?? null;
      const plate = open.includes(m) ? (storedPlates.get(m.id) ?? null) : plateOfMeal(m.plate);
      const samePlate = JSON.stringify(plate) === JSON.stringify(plateOfMeal(m.plate));
      if (key === m.toppingKey && amount === m.toppingAmount && samePlate) continue;
      await tx.plannedMeal.update({
        where: { id: m.id },
        data: {
          toppingKey: key,
          toppingAmount: amount,
          ...(samePlate ? {} : { plate: plateAsJson(plate) }),
        },
      });
    }
    // A meal whose dish the other plan's meal no longer holds is that person's own now as well: a topping on
    // their plate goes too, and their day is sized again. Done once this day's toppings are written, so that
    // their day finds none here to send it back.
    const diverged = partners
      .filter((shared) => !oneDish.has(shared.id))
      .map((shared) => shared.id);
    if (diverged.length > 0) {
      const theirs = await tx.plannedMeal.findMany({
        where: {
          sharedMealId: { in: diverged },
          OR: [{ toppingKey: { not: null } }, { plate: { not: Prisma.DbNull } }],
          eatenAt: null,
          day: { planId: { not: day.planId } },
        },
        select: { dayId: true, day: { select: { planId: true } } },
      });
      for (const dayId of new Set(theirs.map((meal) => meal.dayId)))
        await this.rebalanceDayInternal(dayId, tx, today);
      // Their plan changed: a client that holds it reads it again.
      for (const planId of new Set(theirs.map((meal) => meal.day.planId)))
        await tx.mealPlan.update({ where: { id: planId }, data: { revision: { increment: 1 } } });
    }
    const after = [
      ...rowsWith(storedPlates),
      ...stays,
      ...toppingRows(
        toppings.map((choice) => ({
          mealId: choice.mealId,
          key: choice.key,
          amount: choice.amount,
        })),
      ),
    ];
    const macrosAfter = rowsMacros(after, (r) => scales.get(r.id) ?? r.quantityScale);
    return {
      feasibility:
        Math.abs(macrosAfter.calories - day.calorieTarget) <=
        REBALANCE_TOLERANCE * day.calorieTarget
          ? 'in-window'
          : 'best-effort',
      changes,
      macrosBefore,
      macrosAfter,
    };
  }

  /**
   * The days of the plan from `from` to its end as the plan-wide sizing counts
   * them, and what it makes of them (`rebalanceDays`): what a day cannot absorb
   * is spread over the others inside their windows, no dish past twice its
   * portion. A day before `today` is done with: its meals stay as they are. A
   * skipped day takes no part. What the profile's diary holds for a day counts
   * as eaten. `instead` stands for one day as a change of its settings would
   * leave it: its target and settings, the scales of its dishes, the meals it
   * loses. Nothing is written: the preview of a change and the change itself
   * read the same.
   */
  async planRest(
    db: Prisma.TransactionClient | PrismaService,
    planId: string,
    from: string,
    today: string,
    instead?: {
      dayId: string;
      day: { calorieTarget: number; overrides: unknown };
      scales: ReadonlyMap<string, number>;
      gone: ReadonlySet<string>;
    },
  ) {
    const plan = await db.mealPlan.findUnique({
      where: { id: planId },
      include: {
        days: {
          orderBy: { date: 'asc' },
          include: { meals: { include: { recipe: { select: REBALANCE_MACRO_SELECT } } } },
        },
      },
    });
    if (!plan) return null;
    // What lies before the day asked for is not changed after the fact.
    const days = plan.days.filter((d) => isoDate(d.date) >= from && !isSkipped(d));
    const diary = await diaryOfDays(db, plan.profileId, days, plan.id);
    const dayRows = days.map((d) => {
      const changed = instead?.dayId === d.id ? instead : undefined;
      const settings = changed
        ? { ...d, calorieTarget: changed.day.calorieTarget, overrides: changed.day.overrides }
        : d;
      return {
        id: d.id,
        date: isoDate(d.date),
        target: settings.calorieTarget,
        past: isoDate(d.date) < today,
        aim: aimOfDay(settings, plan),
        rows: d.meals
          .filter((meal) => !changed?.gone.has(meal.id))
          .map(toRebalanceRow)
          .map((row) => {
            const scale = changed?.scales.get(row.id);
            return scale === undefined ? row : { ...row, quantityScale: scale };
          }),
        // Each day's own row of what its diary holds: the ids of the meals are the plan's.
        diary: [
          ...restRebalanceRows(d.meals),
          ...diaryRows(diary.get(isoDate(d.date)), `diary:${isoDate(d.date)}`),
        ],
      };
    });
    const result = rebalanceDays(
      dayRows.map((d) => ({
        target: d.target,
        aim: d.aim,
        meals: [...d.rows, ...d.diary].map((row) => ({
          ...toEngineMeal(row),
          locked: toEngineMeal(row).locked || d.past,
        })),
      })),
    );
    /** What a day holds, in kcal, at `scaleOf` of its rows. */
    const kcalOf = (day: (typeof dayRows)[number], scaleOf: (r: RebalanceRow) => number) =>
      rowsMacros([...day.rows, ...day.diary], scaleOf).calories;
    return {
      dayRows,
      result,
      /** What each day holds after the sizing, and before it, by its id. */
      kcal: new Map(
        dayRows.map((day) => [
          day.id,
          {
            before: kcalOf(day, (r) => r.quantityScale),
            after: kcalOf(day, (r) => result.scales.get(r.id) ?? r.quantityScale),
          },
        ]),
      ),
    };
  }

  /**
   * Share the surplus/deficit across the days from `from` to the end of the
   * plan (`planRest`), and write it.
   */
  async rebalanceRestInternal(
    planId: string,
    tx: Prisma.TransactionClient,
    from: string,
    today: string,
  ): Promise<RebalanceSummary | null> {
    const planned = await this.planRest(tx, planId, from, today);
    if (!planned) return null;
    const { dayRows, result } = planned;
    const { scales, feasibility, unabsorbed } = result;
    const allRows = dayRows.flatMap((d) => d.rows);
    const counted = dayRows.flatMap((d) => [...d.rows, ...d.diary]);
    const macrosBefore = rowsMacros(counted, (r) => r.quantityScale);
    const changes = await this.persistScales(allRows, scales, tx);
    const macrosAfter = rowsMacros(counted, (r) => scales.get(r.id) ?? r.quantityScale);
    return {
      feasibility,
      changes,
      macrosBefore,
      macrosAfter,
      unabsorbedKcal: Math.round(unabsorbed),
    };
  }

  /** Persist only the meals whose quantity scale actually changed. */
  private async persistScales(
    rows: RebalanceRow[],
    scales: Map<string, number>,
    tx: Prisma.TransactionClient,
  ): Promise<RebalanceChange[]> {
    const changes: RebalanceChange[] = [];
    const now = new Date();
    for (const r of rows) {
      const next = scales.get(r.id);
      if (next === undefined || Math.abs(next - r.quantityScale) < 1e-9) continue;
      changes.push({ mealId: r.id, before: r.quantityScale, after: next });
      await tx.plannedMeal.update({
        where: { id: r.id },
        data: { quantityScale: next, lastRebalanceAt: now },
      });
    }
    return changes;
  }

  /**
   * What a day would come to, in kcal, with its meals sized for the target and
   * kind `day` gives it, as a change of the day's settings sizes them: the
   * meals, and what its diary holds as eaten; and the scale each meal takes.
   * Nothing is written.
   */
  resizedDay(
    meals: RebalanceMealRow[],
    day: { calorieTarget: number; overrides: unknown },
    diary: Pick<DiaryOnDay, 'nutrition'> | null,
    plan: { dietType: string; macroSplit: unknown; calorieTarget: number },
  ): { kcal: number; scales: Map<string, number> } {
    const rows = [...meals.map(toRebalanceRow), ...restRebalanceRows(meals), ...diaryRows(diary)];
    const { scales } = sizeDay(rows.map(toEngineMeal), day.calorieTarget, aimOfDay(day, plan));
    return {
      kcal: Math.round(rowsMacros(rows, (r) => scales.get(r.id) ?? r.quantityScale).calories),
      scales,
    };
  }

  /**
   * Whether sizing a day again would give one of its meals another portion (`MealPlanDay.resizes`), worked out as
   * `rebalanceDayInternal` would size it and not written. A day of a joint plan chooses its plates and toppings again
   * as well: it is offered wherever it has a meal of a recipe not eaten yet.
   */
  resizes(
    meals: RebalanceMealRow[],
    day: { calorieTarget: number; overrides: unknown },
    diary: Pick<DiaryOnDay, 'nutrition'> | null,
    plan: {
      dietType: string;
      macroSplit: unknown;
      calorieTarget: number;
      jointPlanId: string | null;
    },
  ): boolean {
    const movable = meals.some(
      (meal) =>
        meal.source !== 'USER_CUSTOM' &&
        meal.recipe !== null &&
        meal.eatenAt === null &&
        meal.leftoverFromDate === null,
    );
    if (!movable) return false;
    if (plan.jointPlanId !== null) return true;
    const { scales } = this.resizedDay(meals, day, diary, plan);
    return meals.some(
      (meal) => Math.abs((scales.get(meal.id) ?? meal.quantityScale) - meal.quantityScale) >= 1e-9,
    );
  }

  /**
   * For each meal of a plan made for cooking ahead, the other meals of the same
   * cooking, as the plan stands. Read before a change: the cookings are what the
   * dishes of the plan make them.
   */
  async cookedWith(
    db: Pick<Prisma.TransactionClient, 'mealPlanDay'>,
    planId: string,
    options: PlanOptions,
  ): Promise<Map<string, CookedMeal[]>> {
    const found = new Map<string, CookedMeal[]>();
    if (!options.mealPrepFriendly) return found;
    const days = await db.mealPlanDay.findMany({
      where: { planId },
      orderBy: { date: 'asc' },
      select: {
        id: true,
        date: true,
        overrides: true,
        meals: {
          select: {
            id: true,
            mealType: true,
            recipeId: true,
            source: true,
            eatenAt: true,
            servings: true,
            quantityScale: true,
            swapHistory: true,
            leftoverFromDate: true,
            leftoverFromMealType: true,
            recipe: { select: { caloriesPerServing: true } },
          },
        },
      },
    });
    const { cookings } = cookingsOf(
      days.map((day) => ({
        date: day.date,
        meals: day.meals.map((meal) => ({
          ...meal,
          recipeId: meal.source === 'USER_CUSTOM' ? null : meal.recipeId,
        })),
      })),
    );
    for (const places of cookings) {
      const meals = places.map(({ day, meal: row, stand }) => ({
        stand,
        meal: {
          id: row.id,
          dayId: days[day]!.id,
          dayIndex: day,
          date: isoDate(days[day]!.date),
          // A leftover standing where it was left: done with, as an eaten meal is.
          mealType: (stand ? row.leftoverFromMealType : row.mealType) as MealType,
          recipeId: row.recipeId!,
          eaten: stand || row.eatenAt !== null,
          skipped: isSkipped(days[day]!),
          swapHistory: stand ? [] : (row.swapHistory ?? []),
          held: row.recipe!.caloriesPerServing * row.servings * row.quantityScale,
        } satisfies CookedMeal,
      }));
      for (const { meal, stand } of meals)
        if (!stand)
          found.set(
            meal.id,
            meals.filter((other) => other.meal !== meal).map((other) => other.meal),
          );
    }
    return found;
  }

  /**
   * Put a recipe on other meals of a cooking, each sized to what it holds now,
   * and return those that took it. A meal that was eaten, or of a day that has
   * passed or is skipped, stays: what was eaten is a record.
   */
  async carryDish(
    tx: Prisma.TransactionClient,
    meals: readonly CookedMeal[],
    recipe: { id: string; caloriesPerServing: number },
    today: string,
    picked: { reason: string | null } | null = null,
  ): Promise<CookedMeal[]> {
    const open = meals.filter((meal) => meal.recipeId !== recipe.id && mayCarry(meal, today));
    for (const meal of open)
      await tx.plannedMeal.update({
        where: { id: meal.id },
        data: {
          recipeId: recipe.id,
          servings: fitServings(recipe.caloriesPerServing, meal.held),
          quantityScale: 1,
          swapHistory: meal.swapHistory.includes(meal.recipeId)
            ? meal.swapHistory
            : [...meal.swapHistory, meal.recipeId],
          modelPicked: picked !== null,
          modelReason: picked?.reason ?? null,
        },
      });
    // Each keeps the rests of packs its new dish holds the ingredients of.
    await settleNewRecipes(
      tx,
      open.map((meal) => meal.id),
    );
    return open;
  }

  /**
   * After the dishes of some days changed: put each new dish on the meals cooked
   * with the one it replaced, on the other days, where it may stand on that meal,
   * and size those days. `cookedWith` is the cookings as they were before the change.
   */
  async carryToOtherDays(
    tx: Prisma.TransactionClient,
    planId: string,
    cookedWith: ReadonlyMap<string, CookedMeal[]>,
    moves: readonly { mealId: string; recipeId: string }[],
    changedDays: ReadonlySet<string>,
    today: string,
  ): Promise<void> {
    const places = moves.flatMap(({ mealId, recipeId }) =>
      (cookedWith.get(mealId) ?? [])
        .filter((meal) => !changedDays.has(meal.dayId))
        .map((meal) => ({ meal, recipeId })),
    );
    if (places.length === 0) return;
    const plan = await tx.mealPlan.findUniqueOrThrow({
      where: { id: planId },
      include: { profile: { include: { preferences: true } } },
    });
    const recipes = await tx.recipe.findMany({
      where: { id: { in: places.map((place) => place.recipeId) } },
      select: { ...CANDIDATE, caloriesPerServing: true },
    });
    if (!plan.profile) return;
    const restrictions = await restrictionsFor(tx, { ...plan, profile: plan.profile });
    const carried: CookedMeal[] = [];
    for (const { meal, recipeId } of places) {
      const recipe = recipes.find((one) => one.id === recipeId);
      if (!recipe || violations(recipe, restrictions, meal.mealType).length > 0) continue;
      carried.push(...(await this.carryDish(tx, [meal], recipe, today)));
    }
    for (const dayId of new Set(carried.map((meal) => meal.dayId)))
      await this.rebalanceDayInternal(dayId, tx, today);
    await this.noteOutsideLimits(
      tx,
      planId,
      carried.map((meal) => meal.id),
    );
  }

  /**
   * What the meals named are outside of, as the plan now stands, goes into its
   * report, and is said for as long as they hold the recipe they hold now.
   */
  async noteOutsideLimits(
    tx: Prisma.TransactionClient,
    planId: string,
    mealIds: readonly string[],
  ): Promise<void> {
    if (mealIds.length === 0) return;
    const plan = await tx.mealPlan.findUniqueOrThrow({
      where: { id: planId },
      select: {
        id: true,
        report: true,
        options: true,
        profile: { select: { preferences: true } },
        days: { orderBy: { date: 'asc' }, select: { id: true, date: true } },
      },
    });
    const kept = StoredReport.nullable().parse(plan.report ?? null);
    if (!kept || !plan.profile) return;
    const limits = await readPlanLimits(
      tx,
      { ...plan, profile: plan.profile },
      this.config.get('DEFAULT_MAX_REPEATS_PER_RECIPE', { infer: true }),
    );
    const meals = await tx.plannedMeal.findMany({
      where: { id: { in: [...mealIds] } },
      select: {
        id: true,
        dayId: true,
        mealType: true,
        recipe: {
          select: {
            id: true,
            prepMinutes: true,
            cookMinutes: true,
            ingredients: LINES_OF_KINDS,
          },
        },
      },
    });
    const report = meals.reduce((sofar, meal) => {
      if (!meal.recipe) return sofar;
      const dayIndex = plan.days.findIndex((day) => day.id === meal.dayId);
      const gaveWay = limits.breaks(meal.recipe, dayIndex, new Set([meal.id]));
      return gaveWay.length === 0
        ? sofar
        : withMealOutside(sofar, {
            date: isoDate(plan.days[dayIndex]!.date),
            slot: meal.mealType as MealType,
            recipeId: meal.recipe.id,
            gaveWay,
          });
    }, kept);
    if (report !== kept) await tx.mealPlan.update({ where: { id: planId }, data: { report } });
  }

  /**
   * Note what the days a swap is about to change hold, for the revision the
   * swap leaves the plan at. Called inside the swap's transaction, before it
   * writes anything.
   */
  async rememberSwap(
    tx: Prisma.TransactionClient,
    planId: string,
    readAtRevision: number,
    dayIds: readonly string[],
    /** The other plan of a joint plan the swap changed as well, at the revision it read: taken back with this one. */
    also: { planId: string; revision: number } | null = null,
  ): Promise<void> {
    const meals = await tx.plannedMeal.findMany({
      where: { dayId: { in: [...dayIds] } },
      select: {
        id: true,
        recipeId: true,
        servings: true,
        quantityScale: true,
        swapHistory: true,
        modelPicked: true,
        modelReason: true,
        toppingKey: true,
        toppingAmount: true,
        rests: true,
        plate: true,
      },
    });
    const lastSwap: StoredSwap = {
      revision: readAtRevision + 1,
      meals,
      ...(also ? { also: { planId: also.planId, revision: also.revision + 1 } } : {}),
    };
    await tx.mealPlan.update({
      where: { id: planId },
      data: { lastSwap: lastSwap as Prisma.InputJsonValue },
    });
  }

  /** Take back the last swap of a plan, on the plan as that swap left it. */
  async undoSwap(
    userId: string,
    locale: Locale,
    req: UndoSwapRequest,
    clientToday: string | null = null,
  ): Promise<RebalanceResult> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: req.planId },
      select: {
        revision: true,
        lastSwap: true,
        profile: { select: { userId: true } },
      },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const swap = StoredSwap.nullable().parse(plan.lastSwap ?? null);
    if (!swap) {
      throw new ConflictException({
        error: 'NOTHING_TO_UNDO',
        message: 'There is no swap of this plan to take back.',
      });
    }
    if (swap.revision !== plan.revision || req.revision !== plan.revision) {
      throw new ConflictException({
        error: 'PLAN_CHANGED',
        message: 'The plan changed after the swap: it can no longer be taken back.',
      });
    }
    // A swap made for both is taken back in the other plan too, while that plan is as the swap left it.
    const also = swap.also
      ? await this.prisma.mealPlan.findFirst({
          where: { id: swap.also.planId, revision: swap.also.revision, profile: { userId } },
          select: { id: true, revision: true, lastSwap: true },
        })
      : null;
    const theirs = also ? StoredSwap.nullable().parse(also.lastSwap ?? null) : null;
    const together =
      also && theirs?.revision === also.revision ? { plan: also, swap: theirs } : null;
    await writePlans(
      this.prisma,
      [
        { planId: req.planId, revision: req.revision },
        ...(together ? [{ planId: together.plan.id, revision: together.plan.revision }] : []),
      ],
      clientToday ?? this.today(),
      async (tx) => {
        for (const [planId, taken] of [
          [req.planId, swap],
          ...(together ? [[together.plan.id, together.swap] as const] : []),
        ] as const) {
          for (const { id, rests, ...before } of taken.meals)
            await tx.plannedMeal.update({
              where: { id },
              data: {
                ...before,
                ...(rests === undefined ? {} : { rests: restsAsJson(restsOf(rests)) }),
              },
            });
          await tx.mealPlan.update({ where: { id: planId }, data: { lastSwap: Prisma.JsonNull } });
        }
      },
    );
    return this.buildRebalanceResult(userId, locale, req.planId, 'day', null);
  }

  /** Undo: write the supplied scales verbatim (the toast's pre-edit map). */
  private async restoreScales(
    planId: string,
    restore: { mealId: string; scale: number }[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const meals = await tx.plannedMeal.findMany({
      where: { id: { in: restore.map((r) => r.mealId) }, day: { planId } },
      select: { id: true, source: true, eatenAt: true, servings: true },
    });
    const byId = new Map(meals.map((m) => [m.id, m]));
    for (const r of restore) {
      const m = byId.get(r.mealId);
      if (!m)
        throw new NotFoundException({
          error: 'MEAL_NOT_FOUND',
          message: 'Planned meal not found.',
        });
      if (m.source === 'USER_CUSTOM' || m.eatenAt != null) {
        throw new BadRequestException({
          error: 'MEAL_NOT_REBALANCEABLE',
          message: 'Custom and eaten meals are never rebalanced.',
        });
      }
      // An undo puts back what a rebalance left, and a rebalance leaves a
      // meal between half a serving and three: nothing else is an undo.
      const servings = m.servings * r.scale;
      if (servings < SERVING_MIN - SCALE_SLACK || servings > SERVING_MAX + SCALE_SLACK) {
        throw new BadRequestException({
          error: 'SCALE_OUT_OF_RANGE',
          message: `A meal holds between ${SERVING_MIN} and ${SERVING_MAX} servings.`,
        });
      }
    }
    const now = new Date();
    for (const r of restore) {
      await tx.plannedMeal.update({
        where: { id: r.mealId },
        data: { quantityScale: r.scale, lastRebalanceAt: now },
      });
    }
  }

  async buildRebalanceResult(
    userId: string,
    locale: Locale,
    planId: string,
    scope: 'day' | 'plan',
    summary: RebalanceSummary | null,
  ): Promise<RebalanceResult> {
    const plan = await this.get(userId, locale, planId);
    return {
      plan,
      rebalance: summary
        ? {
            scope,
            feasibility: summary.feasibility,
            changes: summary.changes,
            unabsorbedKcal: summary.unabsorbedKcal ?? 0,
            macrosBefore: summary.macrosBefore,
            macrosAfter: summary.macrosAfter,
          }
        : null,
    };
  }

  private toSummary(
    plan: SummarisedPlan,
    pieces: PieceUses,
    toppingFoods: ToppingFoods,
    diary: Map<string, DiaryOnDay>,
  ): MealPlanSummary {
    const days = piecedDays(plan.days, pieces).map((day) => ({
      skipped: isSkipped(day),
      nutrition: dayAsItStands(
        day.meals,
        day.meals.flatMap((meal) => {
          const figures = toppingFiguresOf(meal, toppingFoods);
          return figures ? [figures.nutrition] : [];
        }),
        diary.get(isoDate(day.date))?.nutrition ?? null,
      ),
    }));
    return {
      id: plan.id,
      profileId: plan.profileId,
      startDate: isoDate(plan.startDate),
      durationDays: plan.durationDays,
      dietType: plan.dietType,
      averageDailyNutrition: averageDay(days),
      ingredientReuseScore: plan.reuseScore,
      generationMode: modelHadAPart(plan.days),
      options: PlanOptions.parse(plan.options),
      revision: plan.revision,
      createdAt: plan.createdAt.toISOString(),
      joint: jointOf(plan),
    };
  }

  private toDto(
    given: PlanWithRelations,
    locale: Locale,
    restrictions: Restrictions,
    diary: Map<string, DiaryOnDay>,
    written: Map<string, DiaryEntry[]>,
    /** The plan's shopping lists, by the days they cover. */
    lists: readonly { fromDate: Date; toDate: Date }[],
    /** The day it is for the client: what its weeks can still change starts there. */
    today: string,
    /** The days after today's and yesterday's, in the plans that hold them, for the leftovers of those days. */
    nextDays: ReadonlyMap<string, NextDay>,
    /** The foods of the toppings the plan's meals have. */
    toppingFoods: ToppingFoods,
    /** What the meals take of the packs (`packedMealsOf`). */
    packed: readonly PackedMeal[],
    /** What the meals take whole of eggs and tortillas (`pieceUsesOf`). */
    pieces: PieceUses,
    /** The profile's freezer as it is now, for what the plan leaves in it. */
    freezerNow: FreezerNow,
  ): MealPlan {
    // Every figure of a meal below counts its pot's whole eggs and tortillas.
    const plan = { ...given, days: piecedDays(given.days, pieces) };
    const listed = (date: Date): boolean =>
      lists.some((list) => list.fromDate <= date && date <= list.toDate);
    const floor = safetyFloor(plan.profile?.sex ?? null);
    const labelLimits = labelLimitsOf(plan.profile?.preferences);
    // What a plan on the custom diet aims at is the split it was made with; one of protein per kilogram, the
    // split its kept grams of protein come to at its target.
    const ownSplit = sharesOfPlanDay(plan, plan.calorieTarget);
    const options = PlanOptions.parse(plan.options);
    // The number of meals a day without one of its own is set for, read from the whole plan.
    const planCount = planMealCount(plan);
    // Sort meals into canonical eating order — Prisma's row order is
    // undefined and shifts after updates, which would look like other meals
    // also changed.
    const inOrder = plan.days.map((day) =>
      [...day.meals].sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType)),
    );
    const cookedOnce = options.mealPrepFriendly
      ? cookingsOf(
          plan.days.map((day) => ({
            date: day.date,
            meals: day.meals.map((m) => ({
              ...m,
              recipeId: m.source === 'USER_CUSTOM' || !m.recipe ? null : m.recipe.id,
            })),
          })),
        )
      : null;
    // Each meal of a cooking: the others, and what all of them together take.
    const cookingOf = new Map<PlannedMeal['id'], NonNullable<PlannedMeal['cooking']>>();
    for (const places of cookedOnce?.cookings ?? []) {
      const of = places.map(({ day, meal, stand }) => ({ day: plan.days[day]!, meal, stand }));
      const recipe = of[0]!.meal.recipe!;
      const servings = Math.max(1, recipe.servings);
      const ingredients = toPlannedIngredients(
        recipe.ingredients,
        (line) =>
          of.reduce(
            (sum, { meal }) =>
              sum +
              (meal.servings *
                meal.quantityScale *
                plateShare(plateOfMeal(meal.plate), line.ingredient) *
                pieceFactorOf(meal.pieces, line.ingredientId)) /
                servings,
            0,
          ),
        locale,
        restAmounts(of.map(({ meal }) => meal)),
      );
      for (const { meal, stand } of of) {
        // A leftover standing where it was left is no meal of that day.
        if (stand) continue;
        cookingOf.set(meal.id, {
          with: of
            .filter((other) => other.meal.id !== meal.id)
            .map((other) => ({
              mealId: other.meal.id,
              date: isoDate(other.day.date),
              mealType: (other.stand
                ? other.meal.leftoverFromMealType
                : other.meal.mealType) as MealType,
              eaten: other.stand || other.meal.eatenAt !== null,
            })),
          ingredients,
        });
      }
    }
    // The times of day a single dish fit when the plan was made, by day, the dish still in its place.
    const kept = StoredReport.nullable().safeParse(plan.report ?? null);
    const single = kept.success && kept.data ? kept.data.singleCandidate : [];
    const usualMeals = options.mealCount ?? plan.profile?.mealCount ?? 3;
    // The settings of the plan and its profile that keep a day off its split, for every day the plan has off it.
    const settings = planSettingsOff(options, plan.profile?.preferences ?? null);
    // The meals the person swapped for another dish.
    const swapped = new Set(
      plan.days.flatMap((day) =>
        day.meals.filter((meal) => meal.swapHistory.length > 0).map((meal) => meal.id),
      ),
    );
    const days: MealPlanDay[] = plan.days.map((day, dayIndex) => {
      const orderedMeals = inOrder[dayIndex]!;
      const meals: PlannedMeal[] = orderedMeals.map((m) => {
        // Effective amount folds the rebalancer multiplier into the baseline.
        const factor = m.servings * m.quantityScale;
        const eatenAt = m.eatenAt ? m.eatenAt.toISOString() : null;
        // Custom meal: no catalogue recipe, macros frozen on the row.
        if (m.source === 'USER_CUSTOM' || !m.recipe) {
          return {
            id: m.id,
            mealType: m.mealType as MealType,
            recipe: null,
            source: 'USER_CUSTOM' as const,
            customName: m.customName ?? null,
            estimated: m.estimated,
            ingredients: [],
            servings: m.servings,
            quantityScale: m.quantityScale,
            eatenAt,
            dietOverride: false,
            restrictionConflicts: [],
            dislikedIngredientIds: [],
            modelPick: null,
            cookAhead: null,
            cooking: null,
            nutrition: mealNutrition(m),
            label: mealLabel(m),
            shared: null,
            leftover: null,
            carriedTo: null,
            leftoverOffer: null,
            topping: null,
          };
        }
        const recipe = toRecipeDto(m.recipe, locale);
        // The recipe's lines are for `recipe.servings` servings; the meal takes `factor` of one.
        const ofRecipe = factor / Math.max(1, m.recipe.servings);
        return {
          id: m.id,
          mealType: m.mealType as MealType,
          recipe,
          ingredients: toPlannedIngredients(
            m.recipe.ingredients,
            // Its pot's eggs and tortillas whole: the meal's share of them.
            (line) => ofRecipe * pieceFactorOf(m.pieces, line.ingredientId),
            locale,
            restAmounts([m]),
            (line) => plateShare(plateOfMeal(m.plate), line.ingredient),
          ),
          source: 'CATALOGUE' as const,
          customName: null,
          estimated: false,
          servings: m.servings,
          quantityScale: m.quantityScale,
          eatenAt,
          // A meal the plan's diet does not admit: a favourite swapped in on
          // purpose, or a recipe whose ingredients turned out not to qualify.
          dietOverride: !fitsDiet(m.recipe.dietTags, plan.dietType),
          // What the profile ruled out after this meal was planned. The diet has
          // its own flag above, and the meal is in the slot it was planned for.
          restrictionConflicts: violations(m.recipe, restrictions, m.mealType, {
            diet: true,
            meal: true,
          }).filter(
            (violation) => violation !== 'not_available',
          ) as PlannedMeal['restrictionConflicts'],
          dislikedIngredientIds: dislikedIn(m.recipe, restrictions),
          modelPick: m.modelPicked ? { reason: m.modelReason } : null,
          cookAhead: cookedOnce?.marks.get(m.id) ?? null,
          cooking: cookingOf.get(m.id) ?? null,
          nutrition: mealNutrition(m),
          label: mealLabel(m),
          shared: null,
          leftover: m.leftoverFromDate
            ? {
                date: isoDate(m.leftoverFromDate),
                mealType: m.leftoverFromMealType as MealType,
                undoable: m.eatenAt === null && m.leftoverUndo !== null,
              }
            : null,
          // A leftover is always eaten the day after the meal it was left of.
          carriedTo: m.givenLeftoverId
            ? {
                date: dateAfter(isoDate(day.date)),
                mealType: m.carriedToMealType as MealType,
              }
            : null,
          leftoverOffer: leftoverOfferOf(m, isoDate(day.date), today, nextDays),
          topping: toppingOf(m, toppingFoods, locale),
        };
      });
      // What the diary holds for the day is eaten, beside the meals.
      const entered = diary.get(isoDate(day.date)) ?? null;
      // A meal's topping is eaten with it.
      const toppings = orderedMeals.flatMap((m) => {
        const figures = toppingFiguresOf(m, toppingFoods);
        return figures ? [figures.label] : [];
      });
      const dayNutrition = sumNutrition([
        ...meals.map((m) => m.nutrition),
        ...meals.flatMap((m) => (m.topping ? [m.topping.nutrition] : [])),
        ...(entered ? [entered.nutrition] : []),
      ]);
      const dayLabel = roundLabel(
        sumLabels([...meals.map((m) => m.label), ...toppings, ...(entered ? [entered.label] : [])]),
      );
      const overrides = parseDayOverrides(day.overrides);
      const skipped = isSkipped(day);
      const standing = standingOf(dayNutrition.calories, day.calorieTarget, skipped);
      const off =
        !skipped && meals.length > 0 && macrosOff(dayNutrition, plan, aimOfDay(day, plan));
      return {
        id: day.id,
        date: isoDate(day.date),
        meals,
        dayNutrition,
        dayLabel,
        labelNotes:
          !skipped && (meals.length > 0 || entered) ? labelNotes(dayLabel, labelLimits) : [],
        diary: entered && {
          entries: entered.entries,
          nutrition: entered.nutrition,
          items: written.get(isoDate(day.date)) ?? [],
          otherPlans: entered.otherPlans.map((eaten) => ({
            ...diaryMealOf(eaten, locale),
            planId: eaten.planId,
          })),
        },
        calorieTarget: day.calorieTarget,
        targetMacros: shownTarget(
          aimOfDay(day, plan),
          day.calorieTarget,
          plan.dietType,
          dayNutrition.carbs,
        ),
        ...standing,
        // Offered where the day stands off its target, from today on.
        resizes:
          !skipped &&
          isoDate(day.date) >= today &&
          standing.offTarget !== null &&
          this.resizes(orderedMeals, day, entered, plan),
        macrosOff: off,
        macrosOffWhy: off
          ? whyMacrosOff({
              held: dayNutrition,
              aim: energyShares(aimOfDay(day, plan)) ?? sharesOfPlanDay(plan, plan.calorieTarget),
              dietType: plan.dietType,
              meals: meals.map((meal, at) => {
                const row = orderedMeals[at]!;
                return {
                  nutrition: meal.nutrition,
                  fixed:
                    row.eatenAt !== null ||
                    row.source === 'USER_CUSTOM' ||
                    row.leftoverFromDate !== null,
                  byHand: swapped.has(row.id) || meal.dietOverride,
                };
              }),
              besides: entered ? entered.nutrition : null,
              overrides: parseDayOverrides(day.overrides),
              usualMeals,
              settings,
              single: single
                .filter(
                  (one) =>
                    one.date === isoDate(day.date) &&
                    orderedMeals.some(
                      (row) => row.mealType === one.slot && row.recipeId === one.recipeId,
                    ),
                )
                .map((one) => one.slot),
            })
          : null,
        skipped,
        belowSafetyFloor: !skipped && day.calorieTarget < floor,
        overrides,
        mealCount: dayMealCount(day, planCount, plan.profile?.mealCount ?? 3),
        listed: listed(day.date),
      };
    });

    // The days as they stand, their diary included: a day resized around its diary is no shortfall of the plan.
    const average = averageDay(
      days.map((day) => ({ skipped: day.skipped, nutrition: day.dayNutrition })),
    );
    // What the days the plan eats on aim at, each by its own target.
    const eaten = plan.days.filter((day) => !isSkipped(day));
    const meanTarget =
      eaten.reduce((sum, day) => sum + day.calorieTarget, 0) / Math.max(1, eaten.length);
    return {
      id: plan.id,
      profileId: plan.profileId,
      startDate: isoDate(plan.startDate),
      durationDays: plan.durationDays,
      dietType: plan.dietType,
      days,
      targetMoved: targetMoved(plan, options, today),
      weeks: planWeeks(
        plan.days.map((day) => ({
          id: day.id,
          date: isoDate(day.date),
          calorieTarget: day.calorieTarget,
          overrides: day.overrides,
          eaten: day.meals.length > 0 && day.meals.every((meal) => meal.eatenAt !== null),
          listed: listed(day.date),
        })),
        plan.calorieTarget,
        today,
      ),
      averageDailyNutrition: average,
      targetMacros: shownTarget(
        macrosForCalories(plan.calorieTarget, plan.dietType, ownSplit),
        plan.calorieTarget,
        plan.dietType,
        average.carbs,
      ),
      averageOff: {
        calories: standingOf(average.calories, meanTarget, eaten.length === 0).offTarget,
        macros: eaten.length > 0 && macrosOff(average, plan),
      },
      ingredientReuseScore: plan.reuseScore,
      packs: keptMarked(
        planPacks(
          packed,
          plan.days.map((day) => isoDate(day.date)),
          locale,
          levelOf(options)?.freezes,
          freezerOf(plan.report),
          [freezerNow],
        ),
        plan.frozenKept,
        plan.packsKept,
      ),
      generationMode: modelHadAPart(plan.days),
      options,
      report: shownReport(plan.report, days),
      revision: plan.revision,
      createdAt: plan.createdAt.toISOString(),
      joint: null,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** What a product of two fractions may be off by. */
const SCALE_SLACK = 1e-6;

/** A plan as far as its summary takes: the row, and what its meals amount to. */
type SummarisedPlan = Prisma.MealPlanGetPayload<object> & {
  days: {
    date: Date;
    overrides: unknown;
    meals: (MealRow & {
      id: string;
      modelPicked: boolean;
      toppingKey: string | null;
      toppingAmount: number | null;
    })[];
  }[];
  joint: { plans: { id: string; profileId: string; profile: { name: string } }[] } | null;
};

/** The other plan of the joint plan a plan belongs to, while it is there. */
const jointOf = (plan: SummarisedPlan): MealPlanSummary['joint'] => {
  const other = plan.joint?.plans.find((one) => one.id !== plan.id);
  return other
    ? { planId: other.id, profileId: other.profileId, profileName: other.profile.name }
    : null;
};

/** A plan that holds a model's pick says that a model had a part in it. */
const modelHadAPart = (
  days: readonly { meals: readonly { modelPicked: boolean }[] }[],
): MealPlan['generationMode'] =>
  days.some((day) => day.meals.some((meal) => meal.modelPicked)) ? 'ai_assisted' : 'deterministic';

interface PlanWithRelations {
  id: string;
  profileId: string;
  jointPlanId: string | null;
  startDate: Date;
  durationDays: number;
  dietType: MealPlan['dietType'];
  calorieTarget: number;
  macroSplit: unknown;
  reuseScore: number;
  options: unknown;
  report: unknown;
  /** The rests of meat and fish it freezes that the pantry was given (`KeptFrozen`). */
  frozenKept: unknown;
  /** What its packs leave that the pantry was given (`KeptLeft`). */
  packsKept: unknown;
  revision: number;
  createdAt: Date;
  /** Whose plan it is: the floor a day's target is compared with follows from it, and its target now. */
  profile:
    | (BaseProfile & {
        name: string;
        sex: Sex | null;
        mealCount: number;
        preferences:
          | (LabelLimitColumns & {
              maxMealsPerDaySameKind: number | null;
              maxMealsPerWeekSameKind: number | null;
            })
          | null;
      })
    | null;
  days: {
    id: string;
    date: Date;
    calorieTarget: number;
    overrides: unknown;
    meals: {
      id: string;
      mealType: string;
      servings: number;
      quantityScale: number;
      source: 'CATALOGUE' | 'USER_CUSTOM';
      customName: string | null;
      estimated: boolean;
      customMacros: unknown;
      rests: unknown;
      plate: unknown;
      eatenAt: Date | null;
      /** The dishes the person swapped this meal from: one at least where it was swapped by hand. */
      swapHistory: string[];
      modelPicked: boolean;
      modelReason: string | null;
      sharedMealId: string | null;
      recipeId: string | null;
      leftoverFromDate: Date | null;
      leftoverFromMealType: string | null;
      leftoverUndo: unknown;
      givenLeftoverId: string | null;
      carriedToMealType: string | null;
      toppingKey: string | null;
      toppingAmount: number | null;
      recipe:
        (Parameters<typeof toRecipeDto>[0] & Candidate & { ingredients: PackedLine[] }) | null;
    }[];
  }[];
}

/** A plan as it is answered of its own, and the rows it was read from. */
interface Assembled {
  plan: PlanWithRelations;
  dto: MealPlan;
  /** What the plan's meals take of the packs, each on its day of the plan. */
  packed: readonly PackedMeal[];
  /** What the plan's meals take whole of eggs and tortillas (`pieceUsesOf`). */
  pieces: PieceUses;
  /** The profile's freezer as it is now, and what the plan takes out of it. */
  freezerNow: FreezerNow;
}

/**
 * A plan's shopping lists, by the days they cover, and the frozen rows of its profile's pantry, as one statement: the
 * plan's view says of every day whether a list holds it, and with its packs what the freezer keeps.
 */
async function listsAndFreezerOf(
  db: Pick<PrismaService, '$queryRaw'>,
  planId: string,
  profileId: string,
): Promise<{ lists: { fromDate: Date; toDate: Date }[]; frozen: FrozenRow[] }> {
  const [row] = await db.$queryRaw<
    {
      lists: { fromDate: string; toDate: string }[];
      frozen: (Omit<FrozenRow, 'frozenAt'> & { frozenAt: string })[];
    }[]
  >`
    SELECT
      COALESCE((
        SELECT json_agg(json_build_object('fromDate', l."fromDate", 'toDate', l."toDate"))
        FROM "ShoppingList" l WHERE l."planId" = ${planId}
      ), '[]'::json) AS "lists",
      COALESCE((
        SELECT json_agg(json_build_object(
          'ingredientId', i."ingredientId", 'quantity', i."quantity", 'unit', i."unit",
          'parcel', i."parcel", 'frozenAt', i."createdAt" AT TIME ZONE 'UTC'))
        FROM "InventoryItem" i WHERE i."profileId" = ${profileId} AND i."frozen"
      ), '[]'::json) AS "frozen"`;
  return {
    lists: (row?.lists ?? []).map((one) => ({
      fromDate: new Date(`${one.fromDate}T00:00:00Z`),
      toDate: new Date(`${one.toDate}T00:00:00Z`),
    })),
    frozen: (row?.frozen ?? []).map((one) => ({ ...one, frozenAt: new Date(one.frozenAt) })),
  };
}

/** The numbers of the packages a plan takes out of the freezer, by food (`StoredReport.freezer`). */
function parcelsOf(freezer: Freezer | null): Map<string, Set<number>> {
  return new Map(
    [...(freezer?.stock ?? [])].map(([ingredientId, list]) => [
      ingredientId,
      new Set(list.map((one) => one.parcel)),
    ]),
  );
}

/** What the rests of packs these meals finish come to, by ingredient, in each ingredient's own unit. */
function restAmounts(meals: readonly { rests: unknown }[]): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const meal of meals)
    for (const rest of restsOf(meal.rests))
      amounts.set(rest.ingredientId, (amounts.get(rest.ingredientId) ?? 0) + rest.amount);
  return amounts;
}

/** What a meal of a plan comes to in servings of its recipe: its servings times the rebalancer's multiplier. */
const eatenServings = (meal: Pick<PlannedMeal, 'servings' | 'quantityScale'>): number =>
  meal.servings * meal.quantityScale;

/**
 * A plan with what it shares with the plan made together with it (`theirs`):
 * which plan that is, and for each meal both eat the other person's portion and
 * what the pot takes, both portions together, or both cookings where the dish
 * is cooked ahead. A meal whose dish the other plan no longer holds at that
 * time is answered as a meal of this plan alone.
 */
function joined(
  mine: Assembled,
  theirs: Assembled,
  apartOf: ReadonlyMap<string, boolean>,
  locale: Locale,
): MealPlan {
  const meals = (assembled: Assembled) =>
    new Map(assembled.dto.days.flatMap((day) => day.meals).map((meal) => [meal.id, meal]));
  const myMeals = meals(mine);
  const theirMeals = meals(theirs);
  const myPieces = mine.pieces;
  const theirPieces = theirs.pieces;
  const theirsByShared = new Map<string, PlannedMeal>();
  for (const day of theirs.plan.days)
    for (const row of day.meals) {
      const meal = theirMeals.get(row.id);
      if (row.sharedMealId && meal) theirsByShared.set(row.sharedMealId, meal);
    }
  // What a meal and the others of its cooking come to, where the dish is cooked at it.
  const cooked = (meal: PlannedMeal, of: ReadonlyMap<string, PlannedMeal>): number =>
    meal.cookAhead === 'cook' && meal.cooking
      ? meal.cooking.with.reduce(
          (sum, other) => sum + (of.has(other.mealId) ? eatenServings(of.get(other.mealId)!) : 0),
          eatenServings(meal),
        )
      : eatenServings(meal);
  const rows = new Map(mine.plan.days.flatMap((day) => day.meals).map((row) => [row.id, row]));
  const theirRows = new Map(
    theirs.plan.days.flatMap((day) => day.meals).map((row) => [row.id, row]),
  );
  // The rows of a meal and the others of its cooking, where the dish is cooked at it.
  const potRows = (
    meal: PlannedMeal,
    of: ReadonlyMap<string, { rests: unknown }>,
  ): { rests: unknown }[] =>
    [
      meal.id,
      ...(meal.cookAhead === 'cook' && meal.cooking
        ? meal.cooking.with.map((other) => other.mealId)
        : []),
    ].flatMap((id) => {
      const found = of.get(id);
      return found ? [found] : [];
    });
  const profileName = theirs.plan.profile?.name ?? '';
  return {
    ...mine.dto,
    joint: { planId: theirs.dto.id, profileId: theirs.dto.profileId, profileName },
    days: mine.dto.days.map((day) => ({
      ...day,
      meals: day.meals.map((meal): PlannedMeal => {
        const row = rows.get(meal.id);
        const sharedId = row?.sharedMealId ?? null;
        const other = sharedId ? theirsByShared.get(sharedId) : undefined;
        if (!sharedId || !other || !row?.recipe || other.recipe?.id !== row.recipe.id) return meal;
        // The pot is the sum of the two plates: each person's servings, each line at its part of their plate.
        const servings = Math.max(1, row.recipe.servings);
        const mine = plateOfMeal(row.plate);
        const theirsPlate = plateOfMeal(theirRows.get(other.id)?.plate);
        // Each portion takes its eggs and tortillas at its pot's factor: one pot's where the two are cooked together.
        const whole = (pieces: PieceUses, id: string, line: RecipeLine): number =>
          pieceFactorOf(pieces.get(id) ?? [], line.ingredientId);
        const all = (line: RecipeLine): number =>
          (cooked(meal, myMeals) *
            plateShare(mine, line.ingredient) *
            whole(myPieces, row.id, line) +
            cooked(other, theirMeals) *
              plateShare(theirsPlate, line.ingredient) *
              whole(theirPieces, other.id, line)) /
          servings;
        return {
          ...meal,
          shared: {
            id: sharedId,
            apart: apartOf.get(sharedId) ?? false,
            with: {
              mealId: other.id,
              planId: theirs.dto.id,
              profileName,
              servings: eatenServings(other),
              calories: other.nutrition.calories,
              eaten: other.eatenAt !== null,
              ingredients: other.ingredients,
            },
            pot: toPlannedIngredients(
              row.recipe.ingredients,
              all,
              locale,
              restAmounts([...potRows(meal, rows), ...potRows(other, theirRows)]),
            ),
          },
        };
      }),
    })),
    // The two plans are cooked in one kitchen: their packs are counted together, and the kitchen freezes where
    // either plan does. A rest "Dodaj do spiżarni" gave a pantry is marked in both plans.
    packs: keptMarked(
      planPacks(
        [
          ...mine.packed,
          ...onDaysOf(
            theirs.packed,
            theirs.plan.days.map((day) => isoDate(day.date)),
            mine.plan.days.map((day) => isoDate(day.date)),
          ),
        ],
        mine.plan.days.map((day) => isoDate(day.date)),
        locale,
        kitchenFreezes(
          PlanOptions.parse(mine.plan.options),
          PlanOptions.parse(theirs.plan.options),
        ),
        oneFreezer(freezerOf(mine.plan.report), freezerOf(theirs.plan.report)),
        [mine.freezerNow, theirs.freezerNow],
      ),
      mine.plan.frozenKept,
      mine.plan.packsKept,
    ),
  };
}

/**
 * The rests of meat and fish a plan freezes that "Dodaj do spiżarni" gave the pantry (`MealPlan.frozenKept`): each
 * by its ingredient and the day it went in, with what was given. Anything that is not one reads as none.
 */
const KeptFrozen = z
  .array(z.object({ ingredientId: z.string(), date: z.string().date(), amount: z.number() }))
  .catch([]);
type KeptFrozen = z.infer<typeof KeptFrozen>;

/**
 * What packs a plan opens and does not finish leave that "Dodaj do spiżarni" gave the pantry as fresh food
 * (`MealPlan.packsKept`): each by its ingredient and the day its pack is opened, with what was given. Anything that is
 * not one reads as none.
 */
const KeptLeft = KeptFrozen;
type KeptLeft = KeptFrozen;

/** The packs of a plan, each rest it freezes and each pack it leaves something of marked where the pantry was given it already. */
function keptMarked(packs: PlanPacks, frozen: unknown, left: unknown): PlanPacks {
  const key = (one: { ingredientId: string; date: string }) => `${one.ingredientId} ${one.date}`;
  const frozenGiven = new Set(KeptFrozen.parse(frozen).map(key));
  const leftGiven = new Set(KeptLeft.parse(left).map(key));
  return {
    ...packs,
    open: packs.open.map((pack) => ({ ...pack, inPantry: leftGiven.has(key(pack)) })),
    frozen: packs.frozen.map((rest) => ({ ...rest, inPantry: frozenGiven.has(key(rest)) })),
  };
}

/** Canonical eating order for sorting planned meals within a day. */
// ── Rebalance helpers ───────────────────────────────────────────────────

type MacroQuad = { calories: number; protein: number; fat: number; carbs: number };

/** Per-baseline-serving macros + state for one meal, fed to the rebalancer. */
interface RebalanceRow {
  id: string;
  per: MacroQuad;
  servings: number;
  quantityScale: number;
  locked: boolean;
  /** The time of day of its meal, for a meal and what is eaten with it (`RebalanceMeal.slot`); none for the diary. */
  slot?: MealType;
}

/** What the days a swap changed held before it, for the revision of the plan it left. */
const StoredSwap = z.object({
  revision: z.number().int(),
  meals: z.array(
    z.object({
      id: z.string(),
      recipeId: z.string().nullable(),
      servings: z.number(),
      quantityScale: z.number(),
      swapHistory: z.array(z.string()),
      modelPicked: z.boolean(),
      modelReason: z.string().nullable(),
      // Left out by a swap remembered before toppings were.
      toppingKey: z.string().nullable().optional(),
      toppingAmount: z.number().nullable().optional(),
      // Left out by a swap remembered before rests of packs were.
      rests: z.unknown().optional(),
    }),
  ),
  /** The other plan of a joint plan the swap was made in as well, at the revision it left that plan at. */
  also: z.object({ planId: z.string(), revision: z.number().int() }).optional(),
});
type StoredSwap = z.infer<typeof StoredSwap>;

/** A meal of a cooking, as a change of the dish of another of its meals reads it. */
export interface CookedMeal {
  id: string;
  dayId: string;
  dayIndex: number;
  date: string;
  mealType: MealType;
  recipeId: string;
  eaten: boolean;
  skipped: boolean;
  swapHistory: string[];
  /** What it holds now, in kcal: what a recipe in its place is sized to. */
  held: number;
}

/** Whether a meal of a cooking can take a dish that another of its meals got. Dates in this form compare as text. */
export const mayCarry = (meal: CookedMeal, today: string): boolean =>
  !meal.eaten && !meal.skipped && meal.date >= today;

/** What a change of a dish would do to these other meals of its cooking, as an offer says it. */
export function cookingChange(
  meals: readonly CookedMeal[],
  today: string,
  takers: readonly CookedMeal[] = meals.filter((meal) => mayCarry(meal, today)),
): CookingChange {
  if (meals.length === 0) return null;
  const place = ({ date, mealType }: CookedMeal) => ({ date, mealType });
  return {
    changes: takers.map(place),
    stays: meals.filter((meal) => !takers.includes(meal)).map(place),
  };
}

interface RebalanceSummary {
  feasibility: 'in-window' | 'best-effort';
  changes: RebalanceChange[];
  macrosBefore: MacroQuad;
  macrosAfter: MacroQuad;
  /** What the days are still off by after a rebalance of the rest of a plan; a day's rebalance leaves it out. */
  unabsorbedKcal?: number;
}

/** Prisma select for the per-serving macros the rebalancer reads off a recipe. */
const REBALANCE_MACRO_SELECT = {
  caloriesPerServing: true,
  proteinPerServing: true,
  fatPerServing: true,
  carbsPerServing: true,
} as const;

export type RebalanceMealRow = {
  id: string;
  mealType: string;
  source: 'CATALOGUE' | 'USER_CUSTOM';
  customMacros: unknown;
  /** The rests of packs it finishes (`restsOf`): what they hold is counted, and never moved. */
  rests: unknown;
  /** A person's own plate of a shared dish (`plateOfMeal`): it changes what a serving holds, and scales with it. */
  plate: unknown;
  eatenAt: Date | null;
  leftoverFromDate: Date | null;
  servings: number;
  quantityScale: number;
  recipe: {
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
  } | null;
};

/** The topping on a meal's plate, as its answer says it; null where it has none, or this instance lacks its food. */
function toppingOf(
  meal: { toppingKey: string | null; toppingAmount: number | null },
  foods: ToppingFoods,
  locale: Locale,
): PlannedMeal['topping'] {
  const food = meal.toppingKey !== null ? foods.get(meal.toppingKey) : undefined;
  const figures = toppingFiguresOf(meal, foods);
  if (!food || !figures) return null;
  const [ingredient] = toPlannedIngredients(
    [
      {
        ingredientId: food.id,
        quantity: meal.toppingAmount!,
        unit: food.canonicalUnit,
        note: null,
        ingredient: food,
      },
    ],
    1,
    locale,
  );
  return { key: meal.toppingKey!, ingredient: ingredient!, nutrition: figures.nutrition };
}

function toRebalanceRow(m: RebalanceMealRow): RebalanceRow {
  const custom = m.source === 'USER_CUSTOM' || !m.recipe;
  const plate = custom ? null : plateOfMeal(m.plate);
  const per: MacroQuad = custom
    ? customMacros(m.customMacros)
    : {
        // What its plate changes of a serving moves with it.
        calories: m.recipe!.caloriesPerServing + (plate?.perServing.calories ?? 0),
        protein: m.recipe!.proteinPerServing + (plate?.perServing.protein ?? 0),
        fat: m.recipe!.fatPerServing + (plate?.perServing.fat ?? 0),
        carbs: m.recipe!.carbsPerServing + (plate?.perServing.carbs ?? 0),
      };
  return {
    id: m.id,
    per,
    servings: m.servings,
    quantityScale: m.quantityScale,
    // Pinned out of the rebalance set: user-owned custom macros, already eaten, or a leftover, which is food there is.
    locked: m.source === 'USER_CUSTOM' || m.eatenAt != null || m.leftoverFromDate != null,
    slot: m.mealType as MealType,
  };
}

/**
 * What a day's diary holds, as a row the rebalance counts and never moves:
 * eaten, like a meal marked as eaten. None where the diary holds nothing for
 * the day. Its id is no meal's.
 */
function diaryRows(
  diary: Pick<DiaryOnDay, 'nutrition'> | null | undefined,
  id = 'diary',
): RebalanceRow[] {
  return diary ? [{ id, per: diary.nutrition, servings: 1, quantityScale: 1, locked: true }] : [];
}

/** The rests of packs a day's meals finish, as rows the sizing of the day counts and never moves: grams of a pack, not a portion. */
function restRebalanceRows(
  meals: readonly { id: string; mealType: string; rests: unknown }[],
): RebalanceRow[] {
  return meals.flatMap((meal) =>
    restsOf(meal.rests).map((rest, index) => ({
      id: `rest:${meal.id}:${index}`,
      per: rest.figures,
      servings: 1,
      quantityScale: 1,
      locked: true,
      slot: meal.mealType as MealType,
    })),
  );
}

/** A meal's topping as a row the sizing of its day counts and never moves. */
function toppingRebalanceRow(
  mealId: string,
  mealType: string,
  per100: MacroQuad,
  amount: number,
): RebalanceRow {
  const part = amount / 100;
  return {
    id: `topping:${mealId}`,
    slot: mealType as MealType,
    per: {
      calories: per100.calories * part,
      protein: per100.protein * part,
      fat: per100.fat * part,
      carbs: per100.carbs * part,
    },
    servings: 1,
    quantityScale: 1,
    locked: true,
  };
}

const toEngineMeal = (r: RebalanceRow): RebalanceMeal => ({
  id: r.id,
  calories: r.per.calories,
  servings: r.servings,
  quantityScale: r.quantityScale,
  locked: r.locked,
  macros: { protein: r.per.protein, fat: r.per.fat, carbs: r.per.carbs },
  ...(r.slot ? { slot: r.slot } : {}),
});

/** Sum the effective macros of meals given a per-meal scale lookup. */
function rowsMacros(rows: RebalanceRow[], scaleOf: (r: RebalanceRow) => number): MacroQuad {
  return rows.reduce(
    (acc, r) => {
      const f = r.servings * scaleOf(r);
      return {
        calories: acc.calories + r.per.calories * f,
        protein: acc.protein + r.per.protein * f,
        fat: acc.fat + r.per.fat * f,
        carbs: acc.carbs + r.per.carbs * f,
      };
    },
    { calories: 0, protein: 0, fat: 0, carbs: 0 },
  );
}

/**
 * The profile's target now beside the plan's own, where they part by
 * `TARGET_MOVED_LEAST_KCAL` or more and a day of the plan is still to come:
 * the plan then offers the new one from today. A plan whose target was typed
 * for it keeps it, and says nothing.
 */
function targetMoved(
  plan: Pick<PlanWithRelations, 'calorieTarget' | 'profile' | 'days'>,
  options: { calorieTargetOverride: number | null },
  today: string,
): MealPlan['targetMoved'] {
  if (!plan.profile || options.calorieTargetOverride !== null) return null;
  if (!plan.days.some((day) => isoDate(day.date) >= today && !isSkipped(day))) return null;
  const profileTarget = planBaseOf(plan.profile).target;
  return Math.abs(profileTarget - plan.calorieTarget) >= TARGET_MOVED_LEAST_KCAL
    ? { profileTarget, planTarget: plan.calorieTarget }
    : null;
}
