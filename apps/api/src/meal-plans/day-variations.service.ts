// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  RegenerateDayRequest,
  type DayVariation,
  type DayVariationMeal,
  type DayVariations,
  type Locale,
  type MealPlan,
  type MealType,
  type Nutrition,
  type PackTally,
  type TakeDayVariationRequest,
  type WeighRequest,
} from '@diet-app/shared';
import { ModelPickService } from '../ai/model-pick.service.js';
import { DAY_VARIATIONS } from '../ai/operations.js';
import { WeighService } from '../ai/weigh.service.js';
import { storedSplit } from '../common/stored-split.js';
import { macrosForCalories, packUse, sharesOf, tallyOf } from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertMayEnter, CANDIDATE, pickIndex, restrictionsFor } from './eligibility.js';
import { mealRank, MealPlansService } from './meal-plans.service.js';
import { isoDate, mealNutrition, sumNutrition } from './plan-days.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { menuNeeds, type PackedMeal } from './plan-menu.js';
import { writePlan } from './plan-write.js';
import { LANGUAGE } from './swap-shared.js';

/** How many ways to fill a day are offered at most. */
const MOST_WAYS = 3;
/** How many draws are made to find them: a few more than are offered, since a draw can come to a day that was there already, or to one outside the limits. */
const DRAWS = 5;

/** The lines of a recipe as the count of packs reads them. */
const LINES = {
  select: {
    ingredientId: true,
    quantity: true,
    unit: true,
    ingredient: {
      select: {
        name: true,
        canonicalUnit: true,
        gramsPerPiece: true,
        density: true,
        packSize: true,
        perishable: true,
      },
    },
  },
} as const;

const titleOf = (
  recipe: { title: string; translations: { locale: string; title: string }[] },
  locale: Locale,
): string =>
  (
    recipe.translations.find((row) => row.locale === locale) ??
    recipe.translations.find((row) => row.locale === 'en')
  )?.title ?? recipe.title;

/**
 * Other ways to fill a day of a plan. The engine makes each of them as it
 * makes a day again: inside the limits of the plan, around the meals that
 * stay, with everything the profile rules out left out. A model, when asked,
 * puts them in order and says a sentence of each; it adds none and takes none
 * away. The way that is taken is written as it was offered: the note that
 * came with it names its meals.
 */
@Injectable()
export class DayVariationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generation: PlanGenerationService,
    private readonly plans: MealPlansService,
    private readonly weigher: WeighService,
    private readonly notes: ModelPickService,
  ) {}

  /** `clientToday` is the day it is for whoever asks: a day that has passed is not filled again. */
  async offer(
    userId: string,
    locale: Locale,
    planId: string,
    dayId: string,
    req: WeighRequest,
    clientToday: string | null = null,
  ): Promise<DayVariations> {
    const date = await this.dateOf(userId, planId, dayId);
    const prepared = await this.generation.prepare(
      userId,
      planId,
      { from: date, to: date },
      RegenerateDayRequest.parse({}),
      clientToday,
    );
    const { plan } = prepared;
    const { dayIndex, staying } = prepared.filled[0]!;
    const day = plan.days[dayIndex]!;
    const stays = new Set(staying);

    // A way is another way when the meals it places are not those the day has, nor those of a way found before it.
    const signature = (placed: readonly { slot: string; recipeId: string }[]): string =>
      placed
        .map((meal) => `${meal.slot}:${meal.recipeId}`)
        .sort()
        .join(' ');
    const replaced = day.meals
      .filter((meal) => !stays.has(meal.id) && meal.recipeId !== null)
      .map((meal) => ({ slot: meal.mealType, recipeId: meal.recipeId! }));
    const seen = new Set([signature(replaced)]);
    const ways: {
      placed: { slot: MealType; recipeId: string; servings: number }[];
      reuse: number;
    }[] = [];
    // Each way is filled around what the day holds and what the ways before it hold, so that it is another day and
    // not the same one with a meal changed, as far as the catalogue has the recipes for it.
    const avoid = new Set(replaced.map((meal) => meal.recipeId));
    // The draws go by the plan as it stands: asked again of the same plan, the same ways come back, which is what
    // lets a model be asked about the ways that are on the screen.
    const firstSeed = pickIndex(`${planId}:${dayId}:${plan.revision}`, 2 ** 31 - DRAWS);
    for (let draw = 0; draw < DRAWS && ways.length < MOST_WAYS; draw += 1) {
      let result;
      try {
        result = await this.generation.draw(
          userId,
          {
            ...prepared,
            days: prepared.days.map((other, index) =>
              index === dayIndex ? { ...other, avoid: new Set(avoid) } : other,
            ),
          },
          firstSeed + draw,
        );
      } catch (err) {
        // A draw that could only fill the day by letting a limit give way is no way to offer.
        if (err instanceof UnprocessableEntityException) continue;
        throw err;
      }
      // Nor is one in which a limit that may give way did so for a meal of the day.
      if (result.report.relaxations.some((entry) => entry.date === date)) continue;
      const placed = result.assignments
        .filter((meal) => meal.dayIndex === dayIndex)
        .map(({ slot, recipeId, servings }) => ({ slot, recipeId, servings }));
      const found = signature(placed);
      if (placed.length === 0 || seen.has(found)) continue;
      seen.add(found);
      ways.push({ placed, reuse: result.ingredientReuseScore });
      for (const meal of placed) avoid.add(meal.recipeId);
    }

    // What every meal of the plan takes now, and the recipes of the ways and of the meals that stay.
    const [menu, recipes] = await Promise.all([
      this.prisma.plannedMeal.findMany({
        where: { day: { planId } },
        select: {
          id: true,
          dayId: true,
          servings: true,
          quantityScale: true,
          recipe: { select: { servings: true, ingredients: LINES } },
        },
      }),
      this.prisma.recipe.findMany({
        where: {
          id: {
            in: [
              ...new Set([
                ...ways.flatMap((way) => way.placed.map((meal) => meal.recipeId)),
                ...day.meals.flatMap((meal) => (meal.recipeId ? [meal.recipeId] : [])),
              ]),
            ],
          },
        },
        select: {
          id: true,
          title: true,
          servings: true,
          caloriesPerServing: true,
          proteinPerServing: true,
          fatPerServing: true,
          carbsPerServing: true,
          ingredients: LINES,
          translations: { select: { locale: true, title: true } },
        },
      }),
    ]);
    const recipeOf = new Map(recipes.map((recipe) => [recipe.id, recipe]));
    const packed = (meal: (typeof menu)[number]): PackedMeal[] =>
      meal.recipe
        ? [
            {
              factor: (meal.servings * meal.quantityScale) / Math.max(1, meal.recipe.servings),
              lines: meal.recipe.ingredients,
            },
          ]
        : [];
    const tally = (meals: readonly PackedMeal[]): PackTally => {
      const { needs, packs } = menuNeeds(meals);
      return tallyOf(packUse(needs, packs));
    };
    // The meals of the other days, and those of this day that stay: what every way has in common.
    const rest = menu.filter((meal) => meal.dayId !== dayId || stays.has(meal.id)).flatMap(packed);

    const stayingMeals: DayVariationMeal[] = day.meals
      .filter((meal) => stays.has(meal.id))
      .map((meal) => ({
        mealType: meal.mealType as MealType,
        title: meal.recipeId
          ? titleOf(recipeOf.get(meal.recipeId)!, locale)
          : (meal.customName ?? ''),
        recipeId: meal.recipeId,
        servings: meal.servings * meal.quantityScale,
        nutrition: mealNutrition(meal),
        stays: true,
      }));
    const inOrder = (meals: DayVariationMeal[]): DayVariationMeal[] =>
      [...meals].sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType));

    let variations: (Omit<DayVariation, 'offer'> & { way: (typeof ways)[number] })[] = ways.map(
      (way) => {
        const placed: DayVariationMeal[] = way.placed.map((meal) => {
          const recipe = recipeOf.get(meal.recipeId)!;
          return {
            mealType: meal.slot,
            title: titleOf(recipe, locale),
            recipeId: recipe.id,
            servings: meal.servings,
            nutrition: {
              calories: Math.round(recipe.caloriesPerServing * meal.servings),
              protein: Math.round(recipe.proteinPerServing * meal.servings),
              fat: Math.round(recipe.fatPerServing * meal.servings),
              carbs: Math.round(recipe.carbsPerServing * meal.servings),
            },
            stays: false,
          };
        });
        const meals = inOrder([...stayingMeals, ...placed]);
        return {
          meals,
          dayNutrition: sumNutrition(meals.map((meal) => meal.nutrition)),
          packs: tally([
            ...rest,
            ...way.placed.map((meal) => ({
              factor: meal.servings / Math.max(1, recipeOf.get(meal.recipeId)!.servings),
              lines: recipeOf.get(meal.recipeId)!.ingredients,
            })),
          ]),
          reason: null,
          way,
        };
      },
    );

    const current = {
      dayNutrition: sumNutrition(day.meals.map(mealNutrition)) as Nutrition,
      packs: tally(menu.flatMap(packed)),
    };
    let aiMeta: DayVariations['aiMeta'] = null;
    let picked = false;
    if (req.weigh && variations.length > 0) {
      const aims = macrosForCalories(
        day.calorieTarget,
        plan.dietType,
        sharesOf(storedSplit(plan.macroSplit)),
      );
      const letter = (index: number): string => String.fromCharCode(97 + index);
      const weighed = await this.weigher.weigh(userId, DAY_VARIATIONS, {
        choice:
          `Ways to fill ${date} of a ${plan.dietType.replace('_', ' ')} meal plan. The day aims at ${Math.round(day.calorieTarget)} kcal, ` +
          `${aims.protein} g of protein, ${aims.fat} g of fat and ${aims.carbs} g of carbohydrate. ` +
          `As it is now the day holds ${current.dayNutrition.calories} kcal, and the plan leaves ${current.packs.wasted} opened packs of food that does not keep more than a fifth full.`,
        matters: [
          'How near the day comes to what it aims at, energy first, then protein.',
          'How few opened packs the plan would leave more than a fifth full.',
          'How well the meals of the day go together, and how much there is to cook.',
        ],
        options: variations.map((variation, index) => ({
          id: letter(index),
          facts:
            `${variation.meals.map((meal) => `${meal.mealType.replace('_', ' ')}: ${meal.title}${meal.stays ? ' (stays)' : ''}`).join('; ')} | ` +
            `${variation.dayNutrition.calories} kcal, protein ${variation.dayNutrition.protein} g, fat ${variation.dayNutrition.fat} g, carbohydrate ${variation.dayNutrition.carbs} g | ` +
            `opened packs left more than a fifth full: ${variation.packs.wasted}`,
        })),
        language: LANGUAGE[locale],
      });
      const byLetter = new Map(variations.map((variation, index) => [letter(index), variation]));
      variations = weighed.order.map((id) => ({
        ...byLetter.get(id)!,
        reason: weighed.said.get(id) ?? null,
      }));
      aiMeta = weighed.meta;
      picked = !weighed.meta.usedDeterministicFallback;
    }

    return {
      date,
      calorieTarget: day.calorieTarget,
      current,
      variations: variations.map(({ way, ...variation }, index) => ({
        ...variation,
        // What a model put first is its pick, and is written as one when it is taken.
        offer: this.notes.signDay(userId, {
          kind: 'day',
          plan: planId,
          day: dayId,
          revision: plan.revision,
          meals: way.placed.map((meal) => [meal.slot, meal.recipeId, meal.servings]),
          reuse: way.reuse,
          picked: picked && index === 0,
          reason: picked && index === 0 ? variation.reason : null,
        }),
      })),
      aiMeta,
    };
  }

  /**
   * Fill the day the way an offer had it. Each recipe is judged again, as any
   * recipe that enters a plan is, and the day is written only onto the plan
   * the offer was made from: a plan that changed since answers `PLAN_CHANGED`.
   */
  async take(
    userId: string,
    locale: Locale,
    planId: string,
    dayId: string,
    req: TakeDayVariationRequest,
  ): Promise<MealPlan> {
    await this.dateOf(userId, planId, dayId);
    const offer = this.notes.dayOffered(userId, req.offer, { plan: planId, day: dayId });
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: { include: { preferences: true } } },
    });
    if (!plan?.profile)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });

    const restrictions = await restrictionsFor(this.prisma, plan);
    const recipes = await this.prisma.recipe.findMany({
      where: { id: { in: offer.meals.map(([, recipeId]) => recipeId) } },
      select: CANDIDATE,
    });
    for (const [mealType, recipeId] of offer.meals) {
      const recipe = recipes.find((candidate) => candidate.id === recipeId);
      if (!recipe)
        throw new BadRequestException({
          error: 'RECIPE_NOT_ELIGIBLE',
          message: 'A recipe of this offer is no longer available.',
        });
      assertMayEnter(recipe, restrictions, mealType, 'RECIPE_NOT_ELIGIBLE');
    }

    await writePlan(this.prisma, planId, offer.revision, async (tx) => {
      // The plan is as it was when the offer was made, so the meals that stay are the ones the offer was made around.
      const meals = await tx.plannedMeal.findMany({
        where: { dayId },
        select: { id: true, eatenAt: true, source: true },
      });
      const staying = meals
        .filter((meal) => meal.eatenAt !== null || meal.source === 'USER_CUSTOM')
        .map((meal) => meal.id);
      await tx.plannedMeal.deleteMany({ where: { dayId, id: { notIn: staying } } });
      await tx.plannedMeal.createMany({
        data: offer.meals.map(([mealType, recipeId, servings]) => ({
          dayId,
          recipeId,
          mealType,
          servings,
          modelPicked: offer.picked,
          modelReason: offer.picked ? offer.reason : null,
        })),
      });
      // A plan that holds a model's pick says that a model had a part in it.
      await tx.mealPlan.update({
        where: { id: planId },
        data: {
          reuseScore: offer.reuse,
          ...(offer.picked ? { generationMode: 'ai_assisted' as const } : {}),
        },
      });
    });
    return this.plans.get(userId, locale, planId);
  }

  /** The date of a day of a plan that is this account's. The plan first: whoever asks about a plan that is not theirs learns nothing about its days. */
  private async dateOf(userId: string, planId: string, dayId: string): Promise<string> {
    const plan = await this.prisma.mealPlan.findFirst({
      where: { id: planId, profile: { userId } },
      select: { id: true },
    });
    if (!plan)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const day = await this.prisma.mealPlanDay.findUnique({
      where: { id: dayId },
      select: { planId: true, date: true },
    });
    if (!day || day.planId !== planId)
      throw new NotFoundException({ error: 'DAY_NOT_FOUND', message: 'Plan day not found.' });
    return isoDate(day.date);
  }
}
