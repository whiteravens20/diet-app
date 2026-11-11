// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  PlanOptions,
  type AiMealSwapPreview,
  type AiSwapMealRequest,
  type ApplyMealSwapRequest,
  type Locale,
  type Macros,
  type MealSwapPreview,
  type MealType,
  type PlanRelaxation,
  type RebalanceResult,
  type SwapMealRequest,
} from '@diet-app/shared';
import type { Prisma } from '@prisma/client';
import { AiRouterService, withUnusableAnswer } from '../ai/ai-router.service.js';
import { ModelPickService } from '../ai/model-pick.service.js';
import { modelText, readModelReply } from '../ai/model-json.js';
import { MEAL_SWAP } from '../ai/operations.js';
import type { Env } from '../config/env.js';
import { diaryDays } from '../diary/diary-days.js';
import {
  energyAway,
  fitServings,
  recipeCoverage,
  requirementsPerServing,
  slotBudgets,
} from '../engine/index.js';
import { stockByIngredient } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toRecipeDto } from '../recipes/recipes.service.js';
import {
  assertMayEnter,
  CANDIDATE,
  pickIndex,
  poolWhere,
  restrictionsFor,
  violations,
  welcome,
  type Waived,
} from './eligibility.js';
import {
  cookingChange,
  MealPlansService,
  mayCarry,
  type CookedMeal,
} from './meal-plans.service.js';
import { aimOfDay, isoDate, mealNutrition, sumNutrition } from './plan-days.js';
import { LINES_OF_KINDS, readPlanLimits, type LimitedRecipe } from './plan-limits.js';
import { writePlans } from './plan-write.js';
import { AI_SWAP_POOL, LANGUAGE, MAX_REASON_CHARS, swappableRecipeOf } from './swap-shared.js';

// What the prompt asks the model to answer with. A reason is welcome and
// never required: a pick without one is still a pick.
const RecipePick = z.object({
  recipeId: z.string().min(1),
  reason: z.unknown().optional(),
});

/** A recipe offered for a meal holds, at the serving that comes nearest, within this share of what the meal holds now. */
const SWAP_ENERGY_WINDOW = 0.15;

/** What a recipe has to say to be offered: what it is held to, and what it holds. */
const OFFERED = {
  ...CANDIDATE,
  caloriesPerServing: true,
  proteinPerServing: true,
  fatPerServing: true,
  carbsPerServing: true,
  prepMinutes: true,
  cookMinutes: true,
  ingredients: LINES_OF_KINDS,
} as const;

/** Whether a recipe, at the serving that comes nearest, holds about what a meal holds: what a swap asks of every recipe it offers. */
export function holdsAbout(caloriesPerServing: number, held: number): boolean {
  return (
    Math.abs(caloriesPerServing * fitServings(caloriesPerServing, held) - held) <=
    held * SWAP_ENERGY_WINDOW
  );
}

/**
 * What the user waived by asking: "show all my favourites" drops the diet for
 * the pools, and for one favourite picked by hand the meal as well.
 * Allergens, skipped ingredients and the avoid mark are never waived.
 */
function waivedBy(req: { strategy: SwapMealRequest['strategy']; allowOffDiet: boolean }): Waived {
  return req.strategy === 'favorite'
    ? { diet: req.allowOffDiet, meal: req.allowOffDiet }
    : { diet: req.allowOffDiet };
}

const noAlternative = () =>
  new NotFoundException({
    error: 'NO_ALTERNATIVE',
    message:
      'No other recipe the profile may be given for this meal, and that its day does not hold already, holds about as much energy as the meal does.',
  });

/**
 * Putting another recipe in the place of a planned meal: one the engine
 * picks, one of the profile's favourites, or one a model picks from what the
 * engine offers it. A recipe is offered first, with what the swap would do,
 * and written when the offer is taken.
 */
@Injectable()
export class MealSwapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouterService,
    private readonly plans: MealPlansService,
    private readonly picks: ModelPickService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** A recipe to put in the place of a planned meal, and what that would do. Nothing is written. */
  async preview(
    userId: string,
    locale: Locale,
    req: SwapMealRequest,
    clientToday: string | null = null,
  ): Promise<MealSwapPreview> {
    const slot = await this.slot(userId, req.planId, req.plannedMealId, clientToday);
    const theirs = await this.theirs(userId, slot, req.forAll, clientToday);
    return this.previewOf(userId, locale, slot, await this.pick(slot, req, theirs), waivedBy(req));
  }

  /**
   * The other person's meal of a shared meal, as a swap reads it, where the
   * swap is asked for both; null otherwise, and for a meal of one plan alone.
   */
  private async theirs(
    userId: string,
    slot: Slot,
    forAll: boolean,
    clientToday: string | null,
  ): Promise<Slot | null> {
    if (!forAll) return null;
    const other = await this.plans.otherOfShared(userId, slot.meal);
    return other ? this.slot(userId, other.day.planId, other.id, clientToday) : null;
  }

  /**
   * The same, with a model asked which recipe to take. The engine decides
   * what the model may choose from: everything the profile may be given for
   * the meal that holds about as much as the meal does now and is not on the
   * day already. Where no model answers, or the answer names none of those,
   * the engine picks, and `aiMeta` says which of the two happened and why.
   */
  async previewWithAi(
    userId: string,
    locale: Locale,
    req: AiSwapMealRequest,
    clientToday: string | null = null,
  ): Promise<AiMealSwapPreview> {
    const slot = await this.slot(userId, req.planId, req.plannedMealId, clientToday);
    const { meal, restrictions } = slot;
    const shown = new Set<string>([slot.recipeId, ...slot.history, ...req.skip]);

    // The model is never shown a recipe it must not pick.
    const candidates = (
      await this.prisma.recipe.findMany({
        where: poolWhere(restrictions, meal.mealType, {}, [slot.recipeId, ...slot.onTheDay]),
        select: {
          ...OFFERED,
          title: true,
          ingredients: {
            orderBy: { position: 'asc' },
            select: {
              ...LINES_OF_KINDS.select,
              ingredient: {
                select: { ...LINES_OF_KINDS.select.ingredient.select, name: true },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
      })
    )
      .filter((candidate) => holdsAbout(candidate.caloriesPerServing, slot.held))
      .filter(forThemToo(await this.theirs(userId, slot, req.forAll, clientToday)));
    if (candidates.length === 0) throw noAlternative();

    // What holds nothing the profile would rather not eat comes before what does, for the model as for the engine.
    const liked = welcome(insideLimits(slot, candidates), restrictions);
    const fresh = liked.filter((candidate) => !shown.has(candidate.id));
    // Nearest what the day aims at first, so that the cut below keeps those.
    let pool = byDayMacros(slot, fresh.length > 0 ? fresh : liked);
    // What the pantry covers comes first, for the model and for the engine's own pick alike.
    const coverage = await this.recipeCoverageMap(
      meal.day.plan.profileId,
      pool.map((candidate) => candidate.id),
      req.respectInventory !== false,
    );
    if (coverage) {
      pool = [...pool].sort((a, b) => (coverage.get(b.id) ?? 0) - (coverage.get(a.id) ?? 0));
    }
    // Cut after filtering and ordering, so the cut never hides what was not
    // shown yet. Twenty-five keeps the prompt small enough for cheap models.
    pool = pool.slice(0, AI_SWAP_POOL);

    const prompt = buildSwapPrompt({
      slot: meal.mealType as MealType,
      budget: slot.held,
      currentTitle: slot.current.title,
      currentKcal: Math.round(slot.current.caloriesPerServing),
      dayWithoutIt: slot.rest,
      dayAim: slot.aim,
      candidates: pool,
      locale,
    });
    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      MEAL_SWAP,
      true,
    );

    // Only one of the candidates counts as a pick. When the model answered with
    // anything else the engine picks, and the response says that it did.
    const offered = text === null ? null : parseAiRecipePick(text);
    const pick = offered && pool.some((candidate) => candidate.id === offered.id) ? offered : null;
    const replacement =
      pool.find((candidate) => candidate.id === pick?.id) ??
      pool[pickIndex(`${req.plannedMealId}:${shown.size}`, pool.length)]!;
    const aiMeta = pick
      ? { ...meta, reason: pick.reason }
      : text === null
        ? meta
        : withUnusableAnswer(meta);

    // The gate: the model's pick and the engine's are judged alike.
    assertMayEnter(replacement, restrictions, meal.mealType, 'RECIPE_NOT_ELIGIBLE');
    const preview = await this.previewOf(userId, locale, slot, replacement);
    // What the model picked goes out with a note of it, which the request that takes the offer hands back.
    const note = pick
      ? this.picks.sign(userId, {
          kind: 'meal',
          meal: req.plannedMealId,
          recipe: replacement.id,
          revision: preview.revision,
          reason: pick.reason,
        })
      : null;
    return { ...preview, aiMeta, pick: note };
  }

  /**
   * Make a swap that was offered. The recipe is judged again, as any recipe
   * that enters a plan is, and written only onto the plan the offer was made
   * from: a plan that changed since answers `PLAN_CHANGED`.
   */
  async apply(
    userId: string,
    locale: Locale,
    req: Omit<ApplyMealSwapRequest, 'together' | 'forAll'> & {
      together?: boolean;
      forAll?: boolean;
    },
    clientToday: string | null = null,
  ): Promise<RebalanceResult> {
    const slot = await this.slot(userId, req.planId, req.plannedMealId, clientToday);
    const { meal, restrictions } = slot;
    // A model's pick is taken with the note that came with it, and with no other.
    const picked = this.picks.taken(userId, req.pick, {
      kind: 'meal',
      meal: req.plannedMealId,
      recipe: req.recipeId,
      revision: req.revision,
    });
    const byHand = req.strategy === 'favorite';
    const refusal = byHand ? 'OFF_DIET_FAVORITE_NOT_ALLOWED' : 'RECIPE_NOT_ELIGIBLE';
    const replacement = await this.prisma.recipe.findUnique({
      where: { id: req.recipeId },
      select: OFFERED,
    });
    if (!replacement) {
      throw new BadRequestException({ error: refusal, message: 'That recipe is not available.' });
    }
    assertMayEnter(replacement, restrictions, meal.mealType, refusal, waivedBy(req));
    // For both: what the other person may be given, and their day does not hold already, as the offer was.
    const theirs = await this.theirs(userId, slot, req.forAll === true, clientToday);
    if (theirs && !forThemToo(theirs, !byHand)(replacement)) {
      throw new BadRequestException({
        error: refusal,
        message:
          'That recipe cannot go to both: the other person may not be given it, or it cannot take the place of their meal.',
      });
    }
    // A favourite picked by hand is the user's own choice of what to eat;
    // anything else keeps to what the meal holds and to a recipe once a day.
    if (!byHand && !holdsAbout(replacement.caloriesPerServing, slot.held)) {
      throw new BadRequestException({
        error: refusal,
        message:
          'That recipe cannot take the place of this meal: no serving of it holds about as much energy as the meal does.',
      });
    }
    if (!byHand && slot.onTheDay.includes(replacement.id)) {
      throw new BadRequestException({
        error: refusal,
        message:
          'That recipe cannot take the place of this meal: another meal of the day holds it already.',
      });
    }

    const servings = fitServings(replacement.caloriesPerServing, slot.held);
    const nextHistory = nextSwapHistory(
      slot.history,
      slot.recipeId,
      !slot.history.includes(replacement.id),
    );
    const replacementId = replacement.id;
    const together = req.together ? takingIt(slot, replacement, waivedBy(req)) : [];
    const today = slot.today;
    // The other person's meals that take the dish: theirs of this meal, and of the others of the cooking that take it.
    const theirPlan = theirs
      ? { planId: theirs.meal.day.planId, revision: theirs.meal.day.plan.revision }
      : null;
    const theirMeals = theirs
      ? await this.plans.partnersOf(userId, [{ id: req.plannedMealId }, ...together])
      : [];
    const summary = await writePlans(
      this.prisma,
      [{ planId: req.planId, revision: req.revision }, ...(theirPlan ? [theirPlan] : [])],
      async (tx) => {
        await this.plans.rememberSwap(
          tx,
          req.planId,
          req.revision,
          [meal.dayId, ...together.map((other) => other.dayId)],
          theirPlan,
        );
        if (theirs && theirPlan) {
          await this.plans.rememberSwap(
            tx,
            theirPlan.planId,
            theirPlan.revision,
            theirMeals.map((other) => other.dayId),
            { planId: req.planId, revision: req.revision },
          );
          await this.plans.carryDish(tx, theirMeals, replacement, today, picked);
          await this.plans.noteOutsideLimits(
            tx,
            theirPlan.planId,
            theirMeals.map((other) => other.id),
          );
          for (const dayId of new Set(theirMeals.map((other) => other.dayId)))
            await this.plans.rebalanceDayInternal(dayId, tx, today);
        }
        await tx.plannedMeal.update({
          where: { id: req.plannedMealId },
          // A fresh recipe is a new baseline for the rebalancer, and says who chose it.
          data: {
            recipeId: replacementId,
            servings,
            swapHistory: nextHistory,
            quantityScale: 1,
            modelPicked: picked !== null,
            modelReason: picked?.reason ?? null,
          },
        });
        const carried = await this.plans.carryDish(tx, together, replacement, today, picked);
        const otherDays = [...new Set(carried.map((other) => other.dayId))];
        // What the recipe is outside of the meals say for as long as they hold it.
        await this.plans.noteOutsideLimits(tx, req.planId, [
          req.plannedMealId,
          ...together.map((other) => other.id),
        ]);
        // The swap changed the day total — pull it back toward target, on each day it changed.
        const summary = await this.plans.rebalanceDayInternal(meal.dayId, tx, today);
        const others = await Promise.all(
          otherDays
            .filter((dayId) => dayId !== meal.dayId)
            .map((dayId) => this.plans.rebalanceDayInternal(dayId, tx, today)),
        );
        return (
          summary && {
            ...summary,
            changes: [...summary.changes, ...others.flatMap((other) => other?.changes ?? [])],
          }
        );
      },
    );
    return this.plans.buildRebalanceResult(userId, locale, req.planId, 'day', summary);
  }

  /**
   * The meal a swap is about: its recipe, what it holds, what was offered for
   * it before, what its plan rules out, and the recipes its day holds already.
   */
  private async slot(
    userId: string,
    planId: string,
    plannedMealId: string,
    clientToday: string | null,
  ) {
    const meal = await this.plans.loadPlannedMeal(userId, planId, plannedMealId);
    const today = clientToday ?? this.plans.today();
    const recipeId = swappableRecipeOf(meal, today);
    const options = PlanOptions.parse(meal.day.plan.options);
    const [restrictions, current, daySlots, limits, diary, cookedWith] = await Promise.all([
      restrictionsFor(this.prisma, meal.day.plan),
      this.prisma.recipe.findUniqueOrThrow({
        where: { id: recipeId },
        select: { title: true, caloriesPerServing: true },
      }),
      this.prisma.plannedMeal.findMany({
        where: { dayId: meal.dayId },
        select: {
          id: true,
          mealType: true,
          recipeId: true,
          source: true,
          customMacros: true,
          servings: true,
          quantityScale: true,
          recipe: {
            select: {
              caloriesPerServing: true,
              proteinPerServing: true,
              fatPerServing: true,
              carbsPerServing: true,
            },
          },
        },
      }),
      readPlanLimits(
        this.prisma,
        meal.day.plan,
        this.config.get('DEFAULT_MAX_REPEATS_PER_RECIPE', { infer: true }),
      ),
      diaryDays(this.prisma, meal.day.plan.profileId, meal.day.date, meal.day.date),
      this.plans.cookedWith(this.prisma, planId, options),
    ]);
    const dayIndex = await this.prisma.mealPlanDay.count({
      where: { planId, date: { lt: meal.day.date } },
    });
    // A day holds a recipe once, as the planner has it: what another meal of
    // the day holds is not offered for this one, unless the plan is for
    // cooking ahead or was let have a recipe twice a day when it was made.
    const twiceADay = options.mealPrepFriendly || options.allowRelaxations.includes('same_day');
    const onTheDay = twiceADay
      ? []
      : daySlots.flatMap((other) =>
          other.id !== meal.id && other.recipeId ? [other.recipeId] : [],
        );
    // What the meal holds now is what a recipe in its place is sized to and
    // held to: the day keeps its total, whatever share of it this meal had
    // come to carry. A meal that holds nothing is taken at its share of the day.
    const share =
      slotBudgets(
        daySlots.map((other) => other.mealType as MealType),
        meal.day.calorieTarget,
      ).get(meal.mealType as MealType) ?? meal.day.calorieTarget;
    const held = current.caloriesPerServing * meal.servings * meal.quantityScale || share;
    // What the day holds without this meal: its other meals and what its diary holds as eaten.
    const entered = diary.get(isoDate(meal.day.date))?.nutrition;
    const rest = sumNutrition([
      ...daySlots.filter((other) => other.id !== meal.id).map(mealNutrition),
      ...(entered ? [entered] : []),
    ]);
    return {
      meal,
      recipeId,
      restrictions,
      current,
      held,
      onTheDay,
      history: meal.swapHistory ?? [],
      limits,
      dayIndex,
      rest,
      aim: aimOfDay(meal.day, meal.day.plan),
      today,
      cooking: cookedWith.get(meal.id) ?? [],
    };
  }

  /** The recipe to offer for a meal, by the strategy that was asked for. */
  private async pick(slot: Slot, req: SwapMealRequest, theirs: Slot | null): Promise<Offered> {
    const { meal, restrictions } = slot;
    const waived = waivedBy(req);
    let replacement: Offered;

    if (req.strategy === 'favorite') {
      // The contract refuses a favourite without its recipe before it gets here.
      const picked = await this.prisma.recipe.findUnique({
        where: { id: req.favoriteRecipeId! },
        select: OFFERED,
      });
      if (!picked) {
        throw new BadRequestException({
          error: 'OFF_DIET_FAVORITE_NOT_ALLOWED',
          message: 'That favourite is not available.',
        });
      }
      // Picked by hand it is not held to energy, for the other person either; what they may be given it is.
      if (theirs && !forThemToo(theirs, false)(picked)) {
        throw new BadRequestException({
          error: 'OFF_DIET_FAVORITE_NOT_ALLOWED',
          message:
            'That favourite cannot go to both: the other person may not be given it, or their day holds it already.',
        });
      }
      replacement = picked;
    } else {
      // One pool for both automatic strategies, in a fixed order: what the
      // profile may be given for the meal and the day does not hold already,
      // of which a serving holds about as much as the meal does now, inside
      // the limits of the plan as far as anything is.
      const pool = insideLimits(
        slot,
        (
          await this.prisma.recipe.findMany({
            where: poolWhere(restrictions, meal.mealType, waived, [
              slot.recipeId,
              ...slot.onTheDay,
            ]),
            select: OFFERED,
            orderBy: { id: 'asc' },
          })
        )
          .filter((candidate) => holdsAbout(candidate.caloriesPerServing, slot.held))
          .filter(forThemToo(theirs)),
      );
      let ranked = pool;
      if (req.strategy === 'favorite_ingredients') {
        const favIngs = new Set(meal.day.plan.profile.preferences?.favoriteIngredientIds ?? []);
        if (favIngs.size === 0) {
          throw new BadRequestException({
            error: 'NO_FAVORITE_INGREDIENTS',
            message: 'Add favourite ingredients on the profile before swapping by them.',
          });
        }
        const hits = (recipe: Offered): number =>
          recipe.ingredients.filter((i) => favIngs.has(i.ingredientId)).length;
        const best = Math.max(0, ...pool.map(hits));
        if (best === 0) {
          throw new NotFoundException({
            error: 'NO_FAVORITE_INGREDIENT_MATCH',
            message: 'No recipe in this slot uses any of your favourite ingredients.',
          });
        }
        // Only the recipes that use the most favourite ingredients compete.
        ranked = pool.filter((recipe) => hits(recipe) === best);
      } else if (pool.length === 0) {
        throw noAlternative();
      }

      // What was offered for this meal before, in earlier swaps and in this
      // sitting, is left out while anything else is there, so that asking
      // again moves on instead of going round between two.
      const shown = new Set<string>([slot.recipeId, ...slot.history, ...req.skip]);
      // A recipe with something the profile would rather not eat is offered only when every other has been ruled out: asking again goes round the others first.
      const liked = welcome(ranked, restrictions);
      const fresh = liked.filter((recipe) => !shown.has(recipe.id));
      const offered = fresh.length > 0 ? fresh : liked;
      // Of those, the third that brings the day nearest what it aims at: the
      // others come up as these have been shown, so asking again goes round them all.
      let candidates = byDayMacros(slot, offered).slice(0, Math.ceil(offered.length / 3));
      if (req.strategy === 'random') {
        // What the pantry covers comes first when the user asked for that; the pick below still rotates.
        const coverage = await this.recipeCoverageMap(
          meal.day.plan.profileId,
          candidates.map((c) => c.id),
          req.respectInventory !== false,
        );
        if (coverage) {
          candidates = [...candidates].sort(
            (a, b) => (coverage.get(b.id) ?? 0) - (coverage.get(a.id) ?? 0),
          );
        }
      }
      // The number of recipes shown so far advances the key, so offers vary even when the candidates stay the same.
      replacement = candidates[pickIndex(`${req.plannedMealId}:${shown.size}`, candidates.length)]!;
    }

    // The gate: whatever chose the recipe, it is judged before it is offered, and again before it is written.
    assertMayEnter(
      replacement,
      restrictions,
      meal.mealType,
      req.strategy === 'favorite' ? 'OFF_DIET_FAVORITE_NOT_ALLOWED' : 'RECIPE_NOT_ELIGIBLE',
      waived,
    );
    return replacement;
  }

  /** What putting `replacement` in the place of the meal would do to the meal and to its day. */
  private async previewOf(
    userId: string,
    locale: Locale,
    slot: Slot,
    replacement: Offered,
    waived: Waived = {},
  ): Promise<MealSwapPreview> {
    const { meal, held } = slot;
    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    const [plan, row] = await Promise.all([
      this.plans.get(userId, locale, meal.day.planId),
      this.prisma.recipe.findUniqueOrThrow({
        where: { id: replacement.id },
        include: {
          ingredients: {
            orderBy: { position: 'asc' },
            include: {
              ingredient: { include: { translations: { where: { locale: { in: locales } } } } },
            },
          },
          translations: { where: { locale: { in: locales } } },
        },
      }),
    ]);
    // The offer is for the plan as it was read. Where the plan changed in the
    // meantime, which a model's answer gives it time to, the offer would be
    // for a meal that may be gone. A plan that is being deleted can be read
    // with its days already gone: that is a changed plan too.
    const day = plan.days.find((candidate) => candidate.id === meal.dayId);
    const planned = day?.meals.find((candidate) => candidate.id === meal.id);
    if (plan.revision !== meal.day.plan.revision || !day || !planned) {
      throw new ConflictException({
        error: 'PLAN_CHANGED',
        message: 'The plan changed while this request was running. Reload it and try again.',
      });
    }
    const before = planned.nutrition;
    const recipe = toRecipeDto(row, locale);
    const servings = fitServings(replacement.caloriesPerServing, held);
    const perServing = recipe.nutritionPerServing;
    const after = {
      calories: Math.round(perServing.calories * servings),
      protein: Math.round(perServing.protein * servings),
      fat: Math.round(perServing.fat * servings),
      carbs: Math.round(perServing.carbs * servings),
    };
    const takers = takingIt(slot, replacement, waived);
    return {
      recipe,
      servings,
      before,
      after,
      dayBefore: day.dayNutrition,
      dayAfter: {
        calories: day.dayNutrition.calories - before.calories + after.calories,
        protein: day.dayNutrition.protein - before.protein + after.protein,
        fat: day.dayNutrition.fat - before.fat + after.fat,
        carbs: day.dayNutrition.carbs - before.carbs + after.carbs,
      },
      calorieTarget: day.calorieTarget,
      targetMacros: slot.aim,
      cooking: cookingChange(slot.cooking, slot.today, takers),
      outsideLimits: outsideLimitsOf(slot, replacement, takers),
      revision: plan.revision,
    };
  }

  /**
   * Batch-score an arbitrary recipe-id list by pantry coverage. Used by
   * the swap paths (deterministic + AI) to re-rank candidates before picking
   * / before sending to the model. Returns null when respectInventory is off
   * or the pantry is empty — callers leave their pool ordering untouched.
   */
  private async recipeCoverageMap(
    profileId: string,
    recipeIds: string[],
    respectInventory: boolean,
  ): Promise<Map<string, number> | null> {
    if (!respectInventory || recipeIds.length === 0) return null;

    const stock = await stockByIngredient(this.prisma, profileId);
    if (stock.size === 0) return null;

    const recipes = await this.prisma.recipe.findMany({
      where: { id: { in: recipeIds } },
      include: {
        ingredients: {
          orderBy: { position: 'asc' },
          include: {
            ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true } },
          },
        },
      },
    });
    const result = new Map<string, number>();
    for (const r of recipes) result.set(r.id, recipeCoverage(requirementsPerServing(r), stock));
    return result;
  }
}

type Slot = Awaited<ReturnType<MealSwapService['slot']>>;

/**
 * Whether a recipe may go to the other person's meal of a shared meal as well
 * (`theirs`): what they may be given at it, not on their day already, and,
 * unless it is a favourite picked by hand, near what their meal holds. Every
 * recipe may where nothing is asked for both.
 */
function forThemToo(
  theirs: Slot | null,
  heldToEnergy = true,
): (
  recipe: Parameters<typeof violations>[0] & { id: string; caloriesPerServing: number },
) => boolean {
  return (recipe) =>
    !theirs ||
    (violations(recipe, theirs.restrictions, theirs.meal.mealType).length === 0 &&
      !theirs.onTheDay.includes(recipe.id) &&
      (!heldToEnergy || holdsAbout(recipe.caloriesPerServing, theirs.held)));
}
type Offered = Prisma.RecipeGetPayload<{ select: typeof OFFERED }>;

/**
 * The limits of the plan a recipe would be outside of in the place of this meal,
 * and of those of its cooking that would take it too.
 */
function outsideLimitsOf(
  slot: Slot,
  recipe: LimitedRecipe,
  together: readonly CookedMeal[] = openCooking(slot),
): PlanRelaxation[] {
  return slot.limits.breaks(
    recipe,
    slot.dayIndex,
    new Set([slot.meal.id, ...together.map((meal) => meal.id)]),
    together.map((meal) => meal.dayIndex),
  );
}

/** The other meals of this meal's cooking that can take another dish with it. */
const openCooking = (slot: Slot): CookedMeal[] =>
  slot.cooking.filter((meal) => mayCarry(meal, slot.today));

/** Of those, the meals `recipe` may stand on. */
const takingIt = (slot: Slot, recipe: Offered, waived: Waived): CookedMeal[] =>
  openCooking(slot).filter(
    (meal) => violations(recipe, slot.restrictions, meal.mealType, waived).length === 0,
  );

/** Of the recipes that could be offered, those inside the limits of the plan; all of them where none is. */
function insideLimits<T extends LimitedRecipe>(slot: Slot, recipes: T[]): T[] {
  const inside = recipes.filter((recipe) => outsideLimitsOf(slot, recipe).length === 0);
  return inside.length > 0 ? inside : recipes;
}

/** The recipes in the order they would bring the day nearest what it aims at, at the serving each would be. */
function byDayMacros<T extends Macroed>(slot: Slot, recipes: T[]): T[] {
  const away = (recipe: T): number => {
    const servings = fitServings(recipe.caloriesPerServing, slot.held);
    return energyAway(
      {
        protein: slot.rest.protein + recipe.proteinPerServing * servings,
        fat: slot.rest.fat + recipe.fatPerServing * servings,
        carbs: slot.rest.carbs + recipe.carbsPerServing * servings,
      },
      slot.aim,
    );
  };
  return recipes
    .map((recipe) => ({ recipe, away: away(recipe) }))
    .sort((a, b) => a.away - b.away || a.recipe.id.localeCompare(b.recipe.id))
    .map(({ recipe }) => recipe);
}

/** A recipe as far as what it holds goes. */
interface Macroed {
  id: string;
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
}

/**
 * The recipes already shown in a slot, after a swap replaced `leaving`. While
 * the pick came from recipes not shown yet, the one leaving joins the list.
 * Once every candidate has been shown the list starts again with it alone, so
 * the next swap sees the earlier ones as fresh.
 */
function nextSwapHistory(
  previous: readonly string[],
  leaving: string,
  fromFresh: boolean,
): string[] {
  if (!fromFresh) return [leaving];
  return previous.includes(leaving) ? [...previous] : [...previous, leaving];
}

interface SwapPromptCandidate {
  id: string;
  title: string;
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  ingredients: { ingredient: { name: string } }[];
}

/**
 * Build the system + user prompt for the meal-swap ranker. Nutrition values
 * are rounded server-side and pinned into the prompt so the model can't move
 * them; the deterministic engine recomputes everything anyway after the pick.
 */
function buildSwapPrompt(input: {
  slot: MealType;
  budget: number;
  currentTitle: string;
  currentKcal: number;
  dayWithoutIt: Macros;
  dayAim: Macros;
  candidates: SwapPromptCandidate[];
  locale: Locale;
}): { system: string; user: string } {
  const lines = input.candidates.map((c) => {
    const mains = c.ingredients
      .map((x) => x.ingredient.name)
      .slice(0, 4)
      .join(', ');
    return `- id=${c.id} | ${c.title} | ${Math.round(c.caloriesPerServing)} kcal · ${Math.round(c.proteinPerServing)}P/${Math.round(c.fatPerServing)}F/${Math.round(c.carbsPerServing)}C | ${mains}`;
  });

  const system =
    'You rank meal-swap candidates for a deterministic meal-planning app. ' +
    'You never invent ingredients or calories — your only job is to pick the ' +
    'best id from the list provided. ' +
    'Respond with valid JSON exactly matching ' +
    '{"recipeId":"<id>","reason":"<one short sentence>"} — no prose, no ' +
    'markdown, no other keys. The reason tells the person who will eat the ' +
    `meal why you picked it; write it in ${LANGUAGE[input.locale]}.`;

  const user = [
    `Slot: ${input.slot}`,
    `Slot calorie budget: ~${Math.round(input.budget)} kcal`,
    `Currently planned: ${input.currentTitle} (${input.currentKcal} kcal per serving)`,
    `The rest of the day holds ${Math.round(input.dayWithoutIt.protein)}P/${Math.round(input.dayWithoutIt.fat)}F/${Math.round(input.dayWithoutIt.carbs)}C; the whole day aims at ${Math.round(input.dayAim.protein)}P/${Math.round(input.dayAim.fat)}F/${Math.round(input.dayAim.carbs)}C.`,
    '',
    'Pick the candidate that:',
    '1. stays closest to the slot calorie budget at one serving,',
    '2. brings the day nearest what it aims at; the candidates nearest it come first,',
    '3. is meaningfully different from the currently planned meal.',
    '',
    'Candidates:',
    ...lines,
    '',
    'Respond with the JSON object only.',
  ].join('\n');

  return { system, user };
}

/**
 * The recipe the model picked and why, as far as its answer says. Null when
 * the answer holds no id, so the service can fall back deterministically.
 */
function parseAiRecipePick(text: string): { id: string; reason: string | null } | null {
  const reply = readModelReply(text, RecipePick);
  if (!reply.ok) return null;
  return { id: reply.value.recipeId, reason: modelText(reply.value.reason, MAX_REASON_CHARS) };
}
