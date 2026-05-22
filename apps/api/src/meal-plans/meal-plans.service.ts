import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  MEAL_SLOTS_BY_COUNT,
  type GeneratePlanRequest,
  type MealPlan,
  type MealPlanDay,
  type MealType,
  type PlannedMeal,
  type SwapIngredientRequest,
  type SwapMealRequest,
  type SwapPreview,
} from '@diet-app/shared';
import {
  calculateCalories,
  optimisePlan,
  substituteIngredient,
  type EngineIngredient,
  type OptimizerRecipe,
} from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toRecipeDto } from '../recipes/recipes.service.js';

type WeeklyTarget = '0.25' | '0.5' | '0.75' | '1.0' | null;

/**
 * Meal-plan generation, retrieval and swapping. Generation is fully
 * deterministic: it calls the optimiser engine, never AI. AI-assisted variants
 * are layered on top later via the AI module.
 */
@Injectable()
export class MealPlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** Deterministically generate and persist a meal plan. */
  async generate(userId: string, req: GeneratePlanRequest): Promise<MealPlan> {
    const profile = await this.loadProfile(userId, req.profileId);

    const calorieTarget =
      req.calorieTargetOverride ??
      calculateCalories({
        age: profile.age,
        sex: profile.sex,
        heightCm: profile.heightCm,
        weightKg: profile.weightKg,
        activityLevel: profile.activityLevel,
        dietType: profile.dietType,
        weeklyLossTarget: profile.weeklyLossTarget as WeeklyTarget,
        manualCalorieTarget: profile.manualCalorieTarget,
      }).dailyTarget;

    const dietType = req.dietType ?? profile.dietType;
    const mealCount = req.mealCount ?? profile.mealCount;
    const mealSlots = MEAL_SLOTS_BY_COUNT[mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!;

    const { optimizerRecipes } = await this.loadEligibleRecipes(profile);

    // Deterministic seed: count of existing plans → "regenerate" yields variety.
    const seed = await this.prisma.mealPlan.count({ where: { profileId: profile.id } });

    const result = optimisePlan({
      recipes: optimizerRecipes,
      days: req.durationDays,
      mealSlots,
      dailyCalorieTarget: calorieTarget,
      targetMacros: { protein: 0, fat: 0, carbs: 0 },
      dietType,
      mealPrepFriendly: req.mealPrepFriendly,
      seed,
    });

    const start = new Date(req.startDate);
    const plan = await this.prisma.mealPlan.create({
      data: {
        profileId: profile.id,
        startDate: start,
        durationDays: req.durationDays,
        dietType,
        calorieTarget,
        generationMode: 'deterministic',
        reuseScore: result.ingredientReuseScore,
        days: {
          create: Array.from({ length: req.durationDays }, (_, dayIndex) => ({
            date: addDays(start, dayIndex),
            calorieTarget,
            meals: {
              create: result.assignments
                .filter((a) => a.dayIndex === dayIndex)
                .map((a) => ({ recipeId: a.recipeId, mealType: a.slot, servings: a.servings })),
            },
          })),
        },
      },
    });

    return this.get(userId, plan.id);
  }

  async list(userId: string, profileId: string): Promise<MealPlan[]> {
    await this.loadProfile(userId, profileId);
    const plans = await this.prisma.mealPlan.findMany({
      where: { profileId },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(plans.map((p) => this.get(userId, p.id)));
  }

  async get(userId: string, planId: string): Promise<MealPlan> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: {
        days: {
          orderBy: { date: 'asc' },
          include: { meals: { include: { recipe: { include: { ingredients: true } } } } },
        },
        profile: true,
      },
    });
    if (!plan) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    return this.toDto(plan);
  }

  /** Swap a planned meal for a random / favorite alternative; applies immediately. */
  async swapMeal(userId: string, req: SwapMealRequest): Promise<MealPlan> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const dietType = meal.day.plan.dietType;

    let replacementId: string;
    if (req.strategy === 'favorite') {
      if (!req.favoriteRecipeId) {
        throw new NotFoundException({ error: 'NO_FAVORITE', message: 'favoriteRecipeId required.' });
      }
      replacementId = req.favoriteRecipeId;
    } else {
      const candidates = await this.prisma.recipe.findMany({
        where: { dietTags: { has: dietType }, mealTypes: { has: meal.mealType }, id: { not: meal.recipeId } },
        select: { id: true },
      });
      if (candidates.length === 0) {
        throw new NotFoundException({ error: 'NO_ALTERNATIVE', message: 'No alternative recipe found.' });
      }
      // Deterministic pick keyed on the planned-meal id.
      replacementId = candidates[hashIndex(req.plannedMealId, candidates.length)]!.id;
    }

    await this.prisma.plannedMeal.update({
      where: { id: req.plannedMealId },
      data: { recipeId: replacementId },
    });
    return this.get(userId, req.planId);
  }

  /**
   * Preview an ingredient substitution inside a planned meal's recipe. Returns
   * the calorie/macro delta; the caller confirms before persisting a variant.
   */
  async previewIngredientSwap(userId: string, req: SwapIngredientRequest): Promise<SwapPreview> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: meal.recipeId },
      include: { ingredients: true },
    });
    const line = recipe.ingredients.find((i) => i.ingredientId === req.fromIngredientId);
    if (!line) throw new NotFoundException({ error: 'INGREDIENT_NOT_IN_RECIPE', message: 'Ingredient not in recipe.' });

    const [from, to] = await Promise.all([
      this.loadEngineIngredient(req.fromIngredientId),
      this.loadEngineIngredient(req.toIngredientId),
    ]);
    const prefs = meal.day.plan.profile.preferences;

    const r = substituteIngredient(from, to, line.quantity, line.unit, {
      dietType: meal.day.plan.dietType,
      allergens: (prefs?.allergens ?? []) as EngineIngredient['allergens'],
      excludedIngredientIds: prefs?.excludedIngredientIds ?? [],
    });

    return {
      before: r.before,
      after: r.after,
      calorieDelta: r.calorieDelta,
      macroDelta: r.macroDelta,
      adjustedQuantity: r.adjustedQuantity,
      explanation: r.explanation,
      valid: r.valid,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async loadProfile(userId: string, profileId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      include: { preferences: true },
    });
    if (!profile) throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    if (profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Profile belongs to another user.' });
    }
    return profile;
  }

  private async loadPlannedMeal(userId: string, planId: string, plannedMealId: string) {
    const meal = await this.prisma.plannedMeal.findUnique({
      where: { id: plannedMealId },
      include: { day: { include: { plan: { include: { profile: { include: { preferences: true } } } } } } },
    });
    if (!meal || meal.day.planId !== planId) {
      throw new NotFoundException({ error: 'MEAL_NOT_FOUND', message: 'Planned meal not found.' });
    }
    if (meal.day.plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    return meal;
  }

  private async loadEngineIngredient(id: string): Promise<EngineIngredient> {
    const i = await this.prisma.ingredient.findUnique({ where: { id } });
    if (!i) throw new NotFoundException({ error: 'INGREDIENT_NOT_FOUND', message: 'Ingredient not found.' });
    return {
      id: i.id,
      name: i.name,
      category: i.category,
      canonicalUnit: i.canonicalUnit,
      gramsPerPiece: i.gramsPerPiece,
      density: i.density,
      caloriesPer100: i.caloriesPer100,
      proteinPer100: i.proteinPer100,
      fatPer100: i.fatPer100,
      carbsPer100: i.carbsPer100,
      allergens: i.allergens as EngineIngredient['allergens'],
      dietCompatibility: i.dietCompatibility as EngineIngredient['dietCompatibility'],
    };
  }

  /**
   * Load recipes compatible with a profile's allergens / exclusions and map
   * them to optimiser input. Diet-type filtering happens inside the optimiser.
   */
  private async loadEligibleRecipes(
    profile: { id: string; preferences: { allergens: string[]; excludedIngredientIds: string[] } | null },
  ): Promise<{ optimizerRecipes: OptimizerRecipe[] }> {
    const allergens = profile.preferences?.allergens ?? [];
    const excluded = new Set(profile.preferences?.excludedIngredientIds ?? []);

    const recipes = await this.prisma.recipe.findMany({ include: { ingredients: true } });
    const favorites = await this.prisma.favorite.findMany({
      where: { profileId: profile.id },
      select: { recipeId: true },
    });
    const favoriteIds = new Set(favorites.map((f) => f.recipeId));

    const optimizerRecipes: OptimizerRecipe[] = recipes
      .filter((r) => !r.allergens.some((a) => allergens.includes(a)))
      .filter((r) => !r.ingredients.some((i) => excluded.has(i.ingredientId)))
      .map((r) => ({
        id: r.id,
        mealTypes: r.mealTypes as MealType[],
        dietTags: r.dietTags as OptimizerRecipe['dietTags'],
        caloriesPerServing: r.caloriesPerServing,
        proteinPerServing: r.proteinPerServing,
        fatPerServing: r.fatPerServing,
        carbsPerServing: r.carbsPerServing,
        ingredientIds: r.ingredients.map((i) => i.ingredientId),
        difficulty: r.difficulty,
        isFavorite: favoriteIds.has(r.id),
      }));

    return { optimizerRecipes };
  }

  private toDto(plan: PlanWithRelations): MealPlan {
    const days: MealPlanDay[] = plan.days.map((day) => {
      const meals: PlannedMeal[] = day.meals.map((m) => {
        const recipe = toRecipeDto(m.recipe);
        const n = recipe.nutritionPerServing;
        return {
          id: m.id,
          mealType: m.mealType as MealType,
          recipe,
          servings: m.servings,
          nutrition: {
            calories: Math.round(n.calories * m.servings),
            protein: Math.round(n.protein * m.servings),
            fat: Math.round(n.fat * m.servings),
            carbs: Math.round(n.carbs * m.servings),
          },
        };
      });
      const dayNutrition = sumNutrition(meals.map((m) => m.nutrition));
      return {
        id: day.id,
        date: isoDate(day.date),
        meals,
        dayNutrition,
        calorieTarget: day.calorieTarget,
        calorieDelta: dayNutrition.calories - day.calorieTarget,
      };
    });

    const avg = days.length
      ? scaleNutrition(
          sumNutrition(days.map((d) => d.dayNutrition)),
          1 / days.length,
        )
      : { calories: 0, protein: 0, fat: 0, carbs: 0 };

    return {
      id: plan.id,
      profileId: plan.profileId,
      startDate: isoDate(plan.startDate),
      durationDays: plan.durationDays,
      dietType: plan.dietType,
      days,
      averageDailyNutrition: avg,
      targetMacros: { protein: 0, fat: 0, carbs: 0 },
      ingredientReuseScore: plan.reuseScore,
      generationMode: plan.generationMode,
      createdAt: plan.createdAt.toISOString(),
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface PlanWithRelations {
  id: string;
  profileId: string;
  startDate: Date;
  durationDays: number;
  dietType: MealPlan['dietType'];
  reuseScore: number;
  generationMode: 'deterministic' | 'ai_assisted';
  createdAt: Date;
  days: {
    id: string;
    date: Date;
    calorieTarget: number;
    meals: { id: string; mealType: string; servings: number; recipe: Parameters<typeof toRecipeDto>[0] }[];
  }[];
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function hashIndex(key: string, modulo: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) * 16777619;
    h >>>= 0;
  }
  return h % modulo;
}

function sumNutrition(items: { calories: number; protein: number; fat: number; carbs: number }[]) {
  return items.reduce(
    (acc, n) => ({
      calories: acc.calories + n.calories,
      protein: acc.protein + n.protein,
      fat: acc.fat + n.fat,
      carbs: acc.carbs + n.carbs,
    }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 },
  );
}

function scaleNutrition(n: { calories: number; protein: number; fat: number; carbs: number }, f: number) {
  return {
    calories: Math.round(n.calories * f),
    protein: Math.round(n.protein * f),
    fat: Math.round(n.fat * f),
    carbs: Math.round(n.carbs * f),
  };
}
