// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  PlanOptions,
  type AiMealSwapPreview,
  type AiSwapMealRequest,
  type ApplyMealSwapRequest,
  type Locale,
  type MealSwapPreview,
  type MealType,
  type RebalanceResult,
  type SwapMealRequest,
} from '@diet-app/shared';
import { AiRouterService, withUnusableAnswer } from '../ai/ai-router.service.js';
import { ModelPickService } from '../ai/model-pick.service.js';
import { modelText, readModelReply } from '../ai/model-json.js';
import { MEAL_SWAP } from '../ai/operations.js';
import {
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
  welcome,
  type Candidate,
  type Waived,
} from './eligibility.js';
import { MealPlansService } from './meal-plans.service.js';
import { writePlan } from './plan-write.js';
import { AI_SWAP_POOL, LANGUAGE, MAX_REASON_CHARS, swappableRecipeOf } from './swap-shared.js';

// What the prompt asks the model to answer with. A reason is welcome and
// never required: a pick without one is still a pick.
const RecipePick = z.object({ recipeId: z.string().min(1), reason: z.unknown() });

/** A recipe offered for a meal holds, at the serving that comes nearest, within this share of what the meal holds now. */
const SWAP_ENERGY_WINDOW = 0.15;

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
  ) {}

  /** A recipe to put in the place of a planned meal, and what that would do. Nothing is written. */
  async preview(userId: string, locale: Locale, req: SwapMealRequest): Promise<MealSwapPreview> {
    const slot = await this.slot(userId, req.planId, req.plannedMealId);
    return this.previewOf(userId, locale, slot, await this.pick(slot, req));
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
  ): Promise<AiMealSwapPreview> {
    const slot = await this.slot(userId, req.planId, req.plannedMealId);
    const { meal, restrictions } = slot;
    const shown = new Set<string>([slot.recipeId, ...slot.history, ...req.skip]);

    // The model is never shown a recipe it must not pick.
    const candidates = (
      await this.prisma.recipe.findMany({
        where: poolWhere(restrictions, meal.mealType, {}, [slot.recipeId, ...slot.onTheDay]),
        select: {
          ...CANDIDATE,
          title: true,
          caloriesPerServing: true,
          proteinPerServing: true,
          fatPerServing: true,
          carbsPerServing: true,
          ingredients: { select: { ingredientId: true, ingredient: { select: { name: true } } } },
        },
        orderBy: { id: 'asc' },
      })
    ).filter((candidate) => holdsAbout(candidate.caloriesPerServing, slot.held));
    if (candidates.length === 0) throw noAlternative();

    // What holds nothing the profile would rather not eat comes before what does, for the model as for the engine.
    const liked = welcome(candidates, restrictions);
    const fresh = liked.filter((candidate) => !shown.has(candidate.id));
    let pool = fresh.length > 0 ? fresh : liked;
    // What the pantry covers comes first, for the model and for the engine's own pick alike.
    const coverage = await this.recipeCoverageMap(
      meal.day.plan.profileId,
      pool.map((candidate) => candidate.id),
      req.respectInventory !== false,
    );
    if (coverage) {
      pool = [...pool].sort(
        (a, b) => (coverage.get(b.id) ?? 0) - (coverage.get(a.id) ?? 0) || a.id.localeCompare(b.id),
      );
    }
    // Cut after filtering and ordering, so the cut never hides what was not
    // shown yet. Twenty-five keeps the prompt small enough for cheap models.
    pool = pool.slice(0, AI_SWAP_POOL);

    const prompt = buildSwapPrompt({
      slot: meal.mealType as MealType,
      budget: slot.held,
      currentTitle: slot.current.title,
      currentKcal: Math.round(slot.current.caloriesPerServing),
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
  async apply(userId: string, locale: Locale, req: ApplyMealSwapRequest): Promise<RebalanceResult> {
    const slot = await this.slot(userId, req.planId, req.plannedMealId);
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
      select: { ...CANDIDATE, caloriesPerServing: true },
    });
    if (!replacement) {
      throw new BadRequestException({ error: refusal, message: 'That recipe is not available.' });
    }
    assertMayEnter(replacement, restrictions, meal.mealType, refusal, waivedBy(req));
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
    const summary = await writePlan(this.prisma, req.planId, req.revision, async (tx) => {
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
      // A plan that holds a model's pick says that a model had a part in it.
      if (picked !== null)
        await tx.mealPlan.update({
          where: { id: req.planId },
          data: { generationMode: 'ai_assisted' },
        });
      // The swap changed the day total — pull it back toward target.
      return this.plans.rebalanceDayInternal(meal.dayId, tx);
    });
    return this.plans.buildRebalanceResult(userId, locale, req.planId, 'day', summary);
  }

  /**
   * The meal a swap is about: its recipe, what it holds, what was offered for
   * it before, what its plan rules out, and the recipes its day holds already.
   */
  private async slot(userId: string, planId: string, plannedMealId: string) {
    const meal = await this.plans.loadPlannedMeal(userId, planId, plannedMealId);
    const recipeId = swappableRecipeOf(meal);
    const [restrictions, current, daySlots] = await Promise.all([
      restrictionsFor(this.prisma, meal.day.plan),
      this.prisma.recipe.findUniqueOrThrow({
        where: { id: recipeId },
        select: { title: true, caloriesPerServing: true },
      }),
      this.prisma.plannedMeal.findMany({
        where: { dayId: meal.dayId },
        select: { id: true, mealType: true, recipeId: true },
      }),
    ]);
    // A day holds a recipe once, as the planner has it: what another meal of
    // the day holds is not offered for this one, unless the plan is for
    // cooking ahead or was let have a recipe twice a day when it was made.
    const options = PlanOptions.parse(meal.day.plan.options);
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
    return {
      meal,
      recipeId,
      restrictions,
      current,
      held,
      onTheDay,
      history: meal.swapHistory ?? [],
    };
  }

  /** The recipe to offer for a meal, by the strategy that was asked for. */
  private async pick(
    slot: Awaited<ReturnType<MealSwapService['slot']>>,
    req: SwapMealRequest,
  ): Promise<Candidate & { caloriesPerServing: number }> {
    const { meal, restrictions } = slot;
    const waived = waivedBy(req);
    let replacement: Candidate & { caloriesPerServing: number };

    if (req.strategy === 'favorite') {
      // The contract refuses a favourite without its recipe before it gets here.
      const picked = await this.prisma.recipe.findUnique({
        where: { id: req.favoriteRecipeId! },
        select: { ...CANDIDATE, caloriesPerServing: true },
      });
      if (!picked) {
        throw new BadRequestException({
          error: 'OFF_DIET_FAVORITE_NOT_ALLOWED',
          message: 'That favourite is not available.',
        });
      }
      replacement = picked;
    } else {
      // One pool for both automatic strategies, in a fixed order: what the
      // profile may be given for the meal and the day does not hold already,
      // of which a serving holds about as much as the meal does now.
      const pool = (
        await this.prisma.recipe.findMany({
          where: poolWhere(restrictions, meal.mealType, waived, [slot.recipeId, ...slot.onTheDay]),
          select: { ...CANDIDATE, caloriesPerServing: true },
          orderBy: { id: 'asc' },
        })
      ).filter((candidate) => holdsAbout(candidate.caloriesPerServing, slot.held));
      let ranked = pool;
      if (req.strategy === 'favorite_ingredients') {
        const favIngs = new Set(meal.day.plan.profile.preferences?.favoriteIngredientIds ?? []);
        if (favIngs.size === 0) {
          throw new BadRequestException({
            error: 'NO_FAVORITE_INGREDIENTS',
            message: 'Add favourite ingredients on the profile before swapping by them.',
          });
        }
        const hits = (recipe: Candidate): number =>
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
      let candidates = fresh.length > 0 ? fresh : liked;
      if (req.strategy === 'random') {
        // What the pantry covers comes first when the user asked for that; the pick below still rotates.
        const coverage = await this.recipeCoverageMap(
          meal.day.plan.profileId,
          candidates.map((c) => c.id),
          req.respectInventory !== false,
        );
        if (coverage) {
          candidates = [...candidates].sort(
            (a, b) =>
              (coverage.get(b.id) ?? 0) - (coverage.get(a.id) ?? 0) || a.id.localeCompare(b.id),
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
    { meal, held }: Awaited<ReturnType<MealSwapService['slot']>>,
    replacement: { id: string; caloriesPerServing: number },
  ): Promise<MealSwapPreview> {
    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    const [plan, row] = await Promise.all([
      this.plans.get(userId, locale, meal.day.planId),
      this.prisma.recipe.findUniqueOrThrow({
        where: { id: replacement.id },
        include: {
          ingredients: {
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
    '',
    'Pick the candidate that:',
    '1. stays closest to the slot calorie budget at one serving,',
    '2. is meaningfully different from the currently planned meal.',
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
