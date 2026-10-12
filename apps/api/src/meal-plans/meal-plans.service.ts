// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  fitsDiet,
  PlanOptions,
  type AddCustomMealRequest,
  type Locale,
  type MealPlan,
  type MealPlanDay,
  type MealPlanPage,
  type MealPlanSummary,
  type MealType,
  type PlanListQuery,
  type PlannedMeal,
  type RebalanceChange,
  type RebalanceRequest,
  type RebalanceResult,
} from '@diet-app/shared';
import {
  safetyFloor,
  macrosForCalories,
  rebalanceDay,
  rebalanceWeek,
  type RebalanceMeal,
} from '../engine/index.js';
import { SERVING_MAX, SERVING_MIN } from '../engine/optimizer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toPlannedIngredients, toRecipeDto } from '../recipes/recipes.service.js';
import { shownReport } from './generation-report.js';
import { averageDay, customMacros, isoDate, isSkipped, mealNutrition, parseDayOverrides, sumNutrition, type MealAmount } from './plan-days.js';
import { releasePlanLists } from '../shopping-lists/shopping-lists.service.js';
import { writePlan } from './plan-write.js';
import { restrictionsFor, violations, type Candidate, type Restrictions } from './eligibility.js';

/**
 * Reading a plan, and what changes a meal without choosing another recipe: a
 * meal of the user's own, what was eaten, the rebalance. Making a plan is
 * `PlanGenerationService`; swaps are `MealSwapService` and
 * `IngredientSwapService`.
 */
@Injectable()
export class MealPlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** Delete a plan and everything under it (days, meals, shopping lists cascade). */
  async remove(userId: string, planId: string): Promise<void> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true },
    });
    if (!plan?.profile || plan.profile.userId !== userId) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const profileId = plan.profile.id;
    // The plan takes its shopping lists with it. What was obtained for the
    // days still ahead is in the kitchen and goes into the pantry first, by
    // the rule a list deleted on its own follows.
    await this.prisma.$transaction(
      async (tx) => {
        await releasePlanLists(tx, planId, profileId);
        await tx.mealPlan.deleteMany({ where: { id: planId } });
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
  async list(userId: string, query: PlanListQuery, clientToday: string | null = null): Promise<MealPlanPage> {
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
      ...(query.status === 'active' ? [Prisma.sql`"startDate" <= ${day(today)} AND ${lastDay} >= ${day(today)}`] : []),
      ...(query.status === 'past' ? [Prisma.sql`${lastDay} < ${day(today)}`] : []),
      ...(query.status === 'upcoming' ? [Prisma.sql`"startDate" > ${day(today)}`] : []),
    ];
    const where = Prisma.join(narrowed, ' AND ');
    const [{ total }] = await this.prisma.$queryRaw<[{ total: number }]>`SELECT COUNT(*)::int AS total FROM "MealPlan" WHERE ${where}`;
    const page = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "MealPlan" WHERE ${where}
      ORDER BY "startDate" DESC, "createdAt" DESC, "id"
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;

    const amount = { caloriesPerServing: true, proteinPerServing: true, fatPerServing: true, carbsPerServing: true } as const;
    const plans = await this.prisma.mealPlan.findMany({
      where: { id: { in: page.map((row) => row.id) } },
      include: {
        days: {
          select: {
            overrides: true,
            meals: { select: { servings: true, quantityScale: true, source: true, customMacros: true, recipe: { select: amount } } },
          },
        },
      },
    });
    const byId = new Map(plans.map((plan) => [plan.id, plan]));
    return {
      items: page.flatMap(({ id }) => {
        const plan = byId.get(id);
        // Deleted between the two reads: it is on no page any more.
        return plan ? [this.toSummary(plan)] : [];
      }),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async get(userId: string, locale: Locale, planId: string): Promise<MealPlan> {
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
                      include: {
                        ingredient: { include: { translations: { where: { locale: { in: trWhere } } } } },
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
    if (!plan?.profile || plan.profile.userId !== userId) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    return this.toDto(plan, locale, await restrictionsFor(this.prisma, plan));
  }

  /**
   * Add a user-authored custom meal to a day. The macros are frozen on
   * the row as the user entered them — the engine never recomputes them, because
   * a custom meal has no ingredient list. Adding it changes the day total, so a
   * day rebalance runs immediately.
   */
  async addCustomMeal(
    userId: string,
    locale: Locale,
    planId: string,
    date: string,
    req: AddCustomMealRequest,
  ): Promise<RebalanceResult> {
    const day = await this.loadDay(userId, planId, date);
    if (![req.nutrition.calories, req.nutrition.protein, req.nutrition.fat, req.nutrition.carbs].every(
      (v) => Number.isFinite(v) && v >= 0,
    )) {
      throw new BadRequestException({
        error: 'CUSTOM_MEAL_INVALID_MACROS',
        message: 'Custom meal macros must be non-negative numbers.',
      });
    }

    const overrides = parseDayOverrides(day.overrides);
    const summary = await writePlan(this.prisma, planId, day.plan.revision, async (tx) => {
      // Adding a meal to a previously-skipped day un-skips it (it now has content).
      if (overrides?.skip) {
        const rest: Record<string, unknown> = { ...(overrides as Record<string, unknown>) };
        delete rest.skip;
        await tx.mealPlanDay.update({
          where: { id: day.id },
          data: { overrides: Object.keys(rest).length > 0 ? (rest as Prisma.InputJsonValue) : Prisma.JsonNull },
        });
      }
      await tx.plannedMeal.create({
        data: {
          dayId: day.id,
          recipeId: null,
          mealType: req.mealType,
          servings: req.servings,
          quantityScale: 1,
          source: 'USER_CUSTOM',
          customName: req.name,
          customMacros: {
            calories: req.nutrition.calories,
            protein: req.nutrition.protein,
            fat: req.nutrition.fat,
            carbs: req.nutrition.carbs,
          },
        },
      });
      return this.rebalanceDayInternal(day.id, tx);
    });
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
  ): Promise<RebalanceResult> {
    const meal = await this.loadPlannedMeal(userId, planId, mealId);
    if ((meal.eatenAt !== null) === eaten) {
      return this.buildRebalanceResult(userId, locale, planId, 'day', null);
    }
    const summary = await writePlan(this.prisma, planId, meal.day.plan.revision, async (tx) => {
      await tx.plannedMeal.update({
        where: { id: mealId },
        data: { eatenAt: eaten ? new Date() : null },
      });
      return this.rebalanceDayInternal(meal.dayId, tx);
    });
    return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
  }

  /**
   * Explicit rebalance. `day` rebalances one date; `week` shares the
   * surplus/deficit across the plan week. `restore` is the undo path: it writes
   * the supplied scales verbatim (the toast's pre-edit `before` map) and skips
   * the solver.
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
      await writePlan(this.prisma, planId, revision, (tx) => this.restoreScales(planId, restore, tx));
      return this.buildRebalanceResult(userId, locale, planId, req.scope, null);
    }

    if (req.scope === 'week') {
      const summary = await writePlan(this.prisma, planId, revision, (tx) =>
        this.rebalanceWeekInternal(planId, tx, req.date ?? clientToday ?? isoDate(new Date())),
      );
      return this.buildRebalanceResult(userId, locale, planId, 'week', summary);
    }

    // The contract refuses a single day without its date before it gets here.
    const day = await this.loadDay(userId, planId, req.date!);
    const summary = await writePlan(this.prisma, planId, revision, (tx) =>
      this.rebalanceDayInternal(day.id, tx),
    );
    return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
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
    if (!profile || profile.userId !== userId) throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
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
      include: { day: { include: { plan: { include: { profile: { include: { preferences: true } } } } } } },
    });
    if (!meal?.day?.plan?.profile || meal.day.planId !== planId || meal.day.plan.profile.userId !== userId) {
      throw new NotFoundException({ error: 'MEAL_NOT_FOUND', message: 'Planned meal not found.' });
    }
    return meal;
  }

  /** Load + authorise a plan day by ISO date. */
  /** The revision of a plan that is `userId`'s: enough to authorise an edit and to start it. */
  private async planOf(userId: string, planId: string): Promise<{ revision: number }> {
    const plan = await this.prisma.mealPlan.findUnique({ where: { id: planId }, select: { revision: true, profile: { select: { userId: true } } } });
    if (!plan?.profile || plan.profile.userId !== userId) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
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

  /**
   * Rebalance one day's unchecked, non-custom meals toward its target and
   * persist the new quantity scales. Returns the summary the UI toast renders,
   * or null when the day has vanished. Runs inside the transaction of the edit
   * that changed the day, whichever service made it.
   */
  async rebalanceDayInternal(
    dayId: string,
    tx: Prisma.TransactionClient,
  ): Promise<RebalanceSummary | null> {
    const day = await tx.mealPlanDay.findUnique({
      where: { id: dayId },
      include: { meals: { include: { recipe: { select: REBALANCE_MACRO_SELECT } } } },
    });
    if (!day) return null;
    const rows = day.meals.map(toRebalanceRow);
    const macrosBefore = rowsMacros(rows, (r) => r.quantityScale);
    const { scales, feasibility } = rebalanceDay(rows.map(toEngineMeal), day.calorieTarget);
    const changes = await this.persistScales(rows, scales, tx);
    const macrosAfter = rowsMacros(rows, (r) => scales.get(r.id) ?? r.quantityScale);
    return { feasibility, changes, macrosBefore, macrosAfter };
  }

  /** Week-aware variant: share the surplus/deficit across the plan week. */
  private async rebalanceWeekInternal(
    planId: string,
    tx: Prisma.TransactionClient,
    from: string,
  ): Promise<RebalanceSummary | null> {
    const plan = await tx.mealPlan.findUnique({
      where: { id: planId },
      include: {
        days: {
          orderBy: { date: 'asc' },
          include: { meals: { include: { recipe: { select: REBALANCE_MACRO_SELECT } } } },
        },
      },
    });
    if (!plan) return null;
    // From the day asked for to the end of its week of the plan. What lies
    // before it is done with, and is not changed after the fact.
    const first = plan.days.findIndex((d) => isoDate(d.date) >= from);
    const days = first === -1 ? [] : plan.days.slice(first, (Math.floor(first / 7) + 1) * 7);
    const dayRows = days.map((d) => ({ target: d.calorieTarget, rows: d.meals.map(toRebalanceRow) }));
    const allRows = dayRows.flatMap((d) => d.rows);
    const macrosBefore = rowsMacros(allRows, (r) => r.quantityScale);
    const { scales, feasibility, unabsorbed } = rebalanceWeek(
      dayRows.map((d) => ({ target: d.target, meals: d.rows.map(toEngineMeal) })),
    );
    const changes = await this.persistScales(allRows, scales, tx);
    const macrosAfter = rowsMacros(allRows, (r) => scales.get(r.id) ?? r.quantityScale);
    return { feasibility, changes, macrosBefore, macrosAfter, unabsorbedKcal: Math.round(unabsorbed) };
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
      if (!m) throw new NotFoundException({ error: 'MEAL_NOT_FOUND', message: 'Planned meal not found.' });
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
    scope: 'day' | 'week',
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

  private toSummary(plan: SummarisedPlan): MealPlanSummary {
    return {
      id: plan.id,
      profileId: plan.profileId,
      startDate: isoDate(plan.startDate),
      durationDays: plan.durationDays,
      dietType: plan.dietType,
      averageDailyNutrition: averageDay(plan.days),
      ingredientReuseScore: plan.reuseScore,
      generationMode: plan.generationMode,
      options: PlanOptions.parse(plan.options),
      revision: plan.revision,
      createdAt: plan.createdAt.toISOString(),
    };
  }

  private toDto(plan: PlanWithRelations, locale: Locale, restrictions: Restrictions): MealPlan {
    const floor = safetyFloor(plan.profile?.sex ?? null);
    const days: MealPlanDay[] = plan.days.map((day) => {
      // Sort meals into canonical eating order — Prisma's row order is
      // undefined and shifts after updates, which would look like other meals
      // also changed.
      const orderedMeals = [...day.meals].sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType));
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
            ingredients: [],
            servings: m.servings,
            quantityScale: m.quantityScale,
            eatenAt,
            dietOverride: false,
            restrictionConflicts: [],
            modelPick: null,
            nutrition: mealNutrition(m),
          };
        }
        const recipe = toRecipeDto(m.recipe, locale);
        return {
          id: m.id,
          mealType: m.mealType as MealType,
          recipe,
          // The recipe's lines are for `recipe.servings` servings; the meal takes `factor` of one.
          ingredients: toPlannedIngredients(m.recipe.ingredients, factor / Math.max(1, m.recipe.servings), locale),
          source: 'CATALOGUE' as const,
          customName: null,
          servings: m.servings,
          quantityScale: m.quantityScale,
          eatenAt,
          // A meal the plan's diet does not admit: a favourite swapped in on
          // purpose, or a recipe whose ingredients turned out not to qualify.
          dietOverride: !fitsDiet(m.recipe.dietTags, plan.dietType),
          // What the profile ruled out after this meal was planned. The diet has
          // its own flag above, and the meal is in the slot it was planned for.
          restrictionConflicts: violations(m.recipe, restrictions, m.mealType, { diet: true, meal: true }).filter(
            (violation) => violation !== 'not_available',
          ) as PlannedMeal['restrictionConflicts'],
          modelPick: m.modelPicked ? { reason: m.modelReason } : null,
          nutrition: mealNutrition(m),
        };
      });
      const dayNutrition = sumNutrition(meals.map((m) => m.nutrition));
      const overrides = parseDayOverrides(day.overrides);
      const skipped = isSkipped(day);
      return {
        id: day.id,
        date: isoDate(day.date),
        meals,
        dayNutrition,
        calorieTarget: day.calorieTarget,
        targetMacros: macrosForCalories(day.calorieTarget, plan.dietType),
        calorieDelta: skipped ? 0 : dayNutrition.calories - day.calorieTarget,
        skipped,
        belowSafetyFloor: !skipped && day.calorieTarget < floor,
        overrides,
      };
    });

    return {
      id: plan.id,
      profileId: plan.profileId,
      startDate: isoDate(plan.startDate),
      durationDays: plan.durationDays,
      dietType: plan.dietType,
      days,
      averageDailyNutrition: averageDay(plan.days),
      targetMacros: macrosForCalories(plan.calorieTarget, plan.dietType),
      ingredientReuseScore: plan.reuseScore,
      generationMode: plan.generationMode,
      options: PlanOptions.parse(plan.options),
      report: shownReport(plan.report, days),
      revision: plan.revision,
      createdAt: plan.createdAt.toISOString(),
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** What a product of two fractions may be off by. */
const SCALE_SLACK = 1e-6;

/** A plan as far as its summary takes: the row, and what its meals amount to. */
type SummarisedPlan = Prisma.MealPlanGetPayload<object> & { days: { overrides: unknown; meals: MealAmount[] }[] };

interface PlanWithRelations {
  id: string;
  profileId: string;
  startDate: Date;
  durationDays: number;
  dietType: MealPlan['dietType'];
  calorieTarget: number;
  reuseScore: number;
  generationMode: 'deterministic' | 'ai_assisted';
  options: unknown;
  report: unknown;
  revision: number;
  createdAt: Date;
  /** Whose plan it is: the floor a day's target is compared with follows from it. */
  profile: { sex: 'male' | 'female' | null } | null;
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
      customMacros: unknown;
      eatenAt: Date | null;
      modelPicked: boolean;
      modelReason: string | null;
      recipe: (Parameters<typeof toRecipeDto>[0] & Candidate) | null;
    }[];
  }[];
}

/** Canonical eating order for sorting planned meals within a day. */
const MEAL_RANK: Record<string, number> = {
  breakfast: 0,
  second_breakfast: 1,
  lunch: 2,
  snack: 3,
  dinner: 4,
};
function mealRank(slot: string): number {
  return MEAL_RANK[slot] ?? 99;
}

// ── Rebalance helpers ───────────────────────────────────────────────────

type MacroQuad = { calories: number; protein: number; fat: number; carbs: number };

/** Per-baseline-serving macros + state for one meal, fed to the rebalancer. */
interface RebalanceRow {
  id: string;
  per: MacroQuad;
  servings: number;
  quantityScale: number;
  locked: boolean;
}

interface RebalanceSummary {
  feasibility: 'in-window' | 'best-effort';
  changes: RebalanceChange[];
  macrosBefore: MacroQuad;
  macrosAfter: MacroQuad;
  /** What a week is still off by after its rebalance; a day's rebalance leaves it out. */
  unabsorbedKcal?: number;
}

/** Prisma select for the per-serving macros the rebalancer reads off a recipe. */
const REBALANCE_MACRO_SELECT = {
  caloriesPerServing: true,
  proteinPerServing: true,
  fatPerServing: true,
  carbsPerServing: true,
} as const;

type RebalanceMealRow = {
  id: string;
  source: 'CATALOGUE' | 'USER_CUSTOM';
  customMacros: unknown;
  eatenAt: Date | null;
  servings: number;
  quantityScale: number;
  recipe: {
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
  } | null;
};

function toRebalanceRow(m: RebalanceMealRow): RebalanceRow {
  const per: MacroQuad =
    m.source === 'USER_CUSTOM' || !m.recipe
      ? customMacros(m.customMacros)
      : {
          calories: m.recipe.caloriesPerServing,
          protein: m.recipe.proteinPerServing,
          fat: m.recipe.fatPerServing,
          carbs: m.recipe.carbsPerServing,
        };
  return {
    id: m.id,
    per,
    servings: m.servings,
    quantityScale: m.quantityScale,
    // Pinned out of the rebalance set: user-owned custom macros or already eaten.
    locked: m.source === 'USER_CUSTOM' || m.eatenAt != null,
  };
}

const toEngineMeal = (r: RebalanceRow): RebalanceMeal => ({
  id: r.id,
  calories: r.per.calories,
  servings: r.servings,
  quantityScale: r.quantityScale,
  locked: r.locked,
});

/** Sum a day/week's effective macros given a per-meal scale lookup. */
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

