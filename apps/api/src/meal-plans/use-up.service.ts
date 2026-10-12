// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, NotFoundException } from '@nestjs/common';
import { PlanOptions, type Locale, type MealType, type Nutrition, type UseUpSuggestion, type UseUpSuggestions, type WeighRequest } from '@diet-app/shared';
import { ModelPickService } from '../ai/model-pick.service.js';
import { USE_UP_SWAPS } from '../ai/operations.js';
import { WeighService } from '../ai/weigh.service.js';
import { amountsPerServing, requirementsPerServing, useUpSwaps, type UseUpMeal } from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pickIngredient } from '../recipes/recipes.service.js';
import { CANDIDATE, poolWhere, restrictionsFor, welcome } from './eligibility.js';
import { holdsAbout } from './meal-swap.service.js';
import { isoDate } from './plan-days.js';
import { LANGUAGE } from './swap-shared.js';

/** A recipe as this service reads it: what the gate reads, what it is called, what a serving holds and takes. */
const RECIPE = {
  ...CANDIDATE,
  title: true,
  servings: true,
  caloriesPerServing: true,
  proteinPerServing: true,
  fatPerServing: true,
  carbsPerServing: true,
  ingredients: {
    select: {
      ingredientId: true,
      quantity: true,
      unit: true,
      ingredient: { select: { name: true, canonicalUnit: true, gramsPerPiece: true, density: true, packSize: true, perishable: true, translations: { select: { locale: true, name: true } } } },
    },
  },
  translations: { select: { locale: true, title: true } },
} as const;

/** The name of a recipe in the language asked for, in English where it has none, as it was written otherwise. */
function titleOf(recipe: { title: string; translations: { locale: string; title: string }[] }, locale: Locale): string {
  return (recipe.translations.find((row) => row.locale === locale) ?? recipe.translations.find((row) => row.locale === 'en'))?.title ?? recipe.title;
}

/**
 * Swaps that would use up what a plan opens (see `engine/use-up.ts`). The
 * engine finds them among the recipes a swap would offer for each meal:
 * what the profile may be given for the meal, that the day does not hold
 * already, and of which a serving holds about what the meal holds now. A
 * model, when asked, puts them in order and says a sentence of each; it
 * adds none and takes none away.
 */
@Injectable()
export class UseUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly weigher: WeighService,
    private readonly picks: ModelPickService,
  ) {}

  /** `clientToday` is the day it is for whoever asks: the meals of days before it are what they were. */
  async suggest(userId: string, locale: Locale, planId: string, req: WeighRequest, clientToday: string | null = null): Promise<UseUpSuggestions> {
    const plan = await this.prisma.mealPlan.findFirst({
      where: { id: planId, profile: { userId } },
      include: {
        profile: { include: { preferences: true } },
        days: { orderBy: { date: 'asc' }, include: { meals: { include: { recipe: { select: RECIPE } } } } },
      },
    });
    if (!plan?.profile) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const restrictions = await restrictionsFor(this.prisma, plan);
    const options = PlanOptions.parse(plan.options);
    const twiceADay = options.mealPrepFriendly || options.allowRelaxations.includes('same_day');
    const today = clientToday ?? isoDate(new Date());

    type Row = NonNullable<(typeof plan.days)[number]['meals'][number]['recipe']>;
    const perServing = (recipe: Row): Map<string, number> => amountsPerServing(requirementsPerServing(recipe));
    // The pack of every ingredient whose opened pack does not keep, of the menu and of what could come into it, and what each is called.
    const packs = new Map<string, number>();
    const known = new Map<string, Row['ingredients'][number]['ingredient']>();
    const learn = (recipe: Row): void => {
      for (const line of recipe.ingredients) {
        known.set(line.ingredientId, line.ingredient);
        if (line.ingredient.perishable && line.ingredient.packSize) packs.set(line.ingredientId, line.ingredient.packSize);
      }
    };

    // The recipes the profile may be given, read once: which of them is for a meal is asked of each as the meals come.
    let everyRecipe: Row[] | null = null;
    const poolFor = async (mealType: string): Promise<Row[]> => {
      if (everyRecipe === null) {
        everyRecipe = await this.prisma.recipe.findMany({ where: poolWhere(restrictions, mealType, { meal: true }), select: RECIPE, orderBy: { id: 'asc' } });
        everyRecipe.forEach(learn);
      }
      return everyRecipe.filter((recipe) => recipe.mealTypes.includes(mealType));
    };

    const fixed = new Map<string, number>();
    const open: UseUpMeal[] = [];
    const about = new Map<string, { date: string; mealType: MealType; recipe: Row; before: Nutrition }>();
    for (const day of plan.days) {
      const date = isoDate(day.date);
      const onTheDay = day.meals.flatMap((meal) => (meal.recipeId ? [meal.recipeId] : []));
      for (const meal of day.meals) {
        // A meal of the user's own takes nothing the catalogue knows of.
        if (meal.source === 'USER_CUSTOM' || !meal.recipe) continue;
        learn(meal.recipe);
        const factor = meal.servings * meal.quantityScale;
        const amounts = new Map([...perServing(meal.recipe)].map(([ingredientId, amount]) => [ingredientId, amount * factor]));
        // What was eaten is a record, and a day that has passed is what it was.
        if (meal.eatenAt !== null || date < today) {
          for (const [ingredientId, amount] of amounts) fixed.set(ingredientId, (fixed.get(ingredientId) ?? 0) + amount);
          continue;
        }
        const held = meal.recipe.caloriesPerServing * factor;
        const others = twiceADay ? [] : onTheDay.filter((recipeId) => recipeId !== meal.recipe!.id);
        const candidates = welcome(
          (await poolFor(meal.mealType)).filter((candidate) => candidate.id !== meal.recipe!.id && !others.includes(candidate.id) && holdsAbout(candidate.caloriesPerServing, held)),
          restrictions,
        );
        open.push({ id: meal.id, recipeId: meal.recipe.id, held, amounts, candidates: candidates.map((candidate) => ({ recipeId: candidate.id, caloriesPerServing: candidate.caloriesPerServing, amounts: perServing(candidate) })) });
        about.set(meal.id, {
          date,
          mealType: meal.mealType as MealType,
          recipe: meal.recipe,
          before: {
            calories: Math.round(meal.recipe.caloriesPerServing * factor),
            protein: Math.round(meal.recipe.proteinPerServing * factor),
            fat: Math.round(meal.recipe.fatPerServing * factor),
            carbs: Math.round(meal.recipe.carbsPerServing * factor),
          },
        });
      }
    }

    const recipeOf = new Map(((everyRecipe as Row[] | null) ?? []).map((recipe) => [recipe.id, recipe]));
    let suggestions: UseUpSuggestion[] = useUpSwaps(open, fixed, packs).map((swap) => {
      const meal = about.get(swap.mealId)!;
      const to = recipeOf.get(swap.recipeId)!;
      return {
        plannedMealId: swap.mealId,
        date: meal.date,
        mealType: meal.mealType,
        from: { id: meal.recipe.id, title: titleOf(meal.recipe, locale) },
        to: { id: to.id, title: titleOf(to, locale) },
        servings: swap.servings,
        before: meal.before,
        after: {
          calories: Math.round(to.caloriesPerServing * swap.servings),
          protein: Math.round(to.proteinPerServing * swap.servings),
          fat: Math.round(to.fatPerServing * swap.servings),
          carbs: Math.round(to.carbsPerServing * swap.servings),
        },
        takes: [...swap.takes]
          .map(([ingredientId, taken]) => {
            const ingredient = known.get(ingredientId)!;
            return {
              ingredientId,
              name: pickIngredient(locale, ingredient.translations, ingredient.name),
              unit: ingredient.canonicalUnit,
              amount: Math.max(1, Math.round(taken.amount)),
              left: Math.round(taken.left),
            };
          })
          .sort((a, b) => b.amount - a.amount),
        packs: { before: swap.before, after: swap.after },
        reason: null,
        pick: null,
      };
    });
    if (!req.weigh || suggestions.length === 0) return { revision: plan.revision, suggestions, aiMeta: null };

    // The model sees each swap under a letter, with what the engine counted: it writes no figure of its own.
    const letter = (index: number): string => String.fromCharCode(97 + index);
    const weighed = await this.weigher.weigh(userId, USE_UP_SWAPS, {
      choice: `A ${plan.dietType.replace('_', ' ')} meal plan opens packs of food that do not keep once they are opened, and leaves more than three tenths of some of them. Each option swaps one meal for a recipe that takes from such a pack.`,
      matters: ['How much less of the opened packs is left to go to waste.', 'How little the meal changes in energy and in protein.', 'How different the dish is from what was planned: say so plainly.'],
      options: suggestions.map((suggestion, index) => ({
        id: letter(index),
        facts:
          `${suggestion.date} ${suggestion.mealType.replace('_', ' ')}: "${suggestion.to.title}" in place of "${suggestion.from.title}" | ` +
          `meal ${suggestion.before.calories} -> ${suggestion.after.calories} kcal, protein ${suggestion.before.protein} -> ${suggestion.after.protein} g | ` +
          `takes ${suggestion.takes.map((taken) => `${taken.amount} ${taken.unit} more of ${taken.name}, leaving ${taken.left} ${taken.unit} of its pack`).join(', ')} | ` +
          `packs left more than three tenths full: ${suggestion.packs.before.wasted} -> ${suggestion.packs.after.wasted}`,
      })),
      language: LANGUAGE[locale],
    });
    const byLetter = new Map(suggestions.map((suggestion, index) => [letter(index), suggestion]));
    suggestions = weighed.order.map((id) => ({ ...byLetter.get(id)!, reason: weighed.said.get(id) ?? null }));
    // What the model put first is its pick, and is written as one when it is taken.
    if (!weighed.meta.usedDeterministicFallback) {
      const first = suggestions[0]!;
      first.pick = this.picks.sign(userId, { kind: 'meal', meal: first.plannedMealId, recipe: first.to.id, revision: plan.revision, reason: first.reason });
    }
    return { revision: plan.revision, suggestions, aiMeta: weighed.meta };
  }
}
