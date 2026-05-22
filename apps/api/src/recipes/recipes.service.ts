import { Injectable, NotFoundException } from '@nestjs/common';
import type { Recipe } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RecipeFilters {
  search?: string;
  dietType?: string;
  mealType?: string;
  maxCalories?: number;
  maxPrepMinutes?: number;
  difficulty?: string;
}

/** Read access to the recipe library (seed + AI-validated + user recipes). */
@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  async search(filters: RecipeFilters): Promise<Recipe[]> {
    const rows = await this.prisma.recipe.findMany({
      where: {
        ...(filters.search ? { title: { contains: filters.search, mode: 'insensitive' } } : {}),
        ...(filters.dietType ? { dietTags: { has: filters.dietType } } : {}),
        ...(filters.mealType ? { mealTypes: { has: filters.mealType } } : {}),
        ...(filters.maxCalories ? { caloriesPerServing: { lte: filters.maxCalories } } : {}),
        ...(filters.maxPrepMinutes ? { prepMinutes: { lte: filters.maxPrepMinutes } } : {}),
        ...(filters.difficulty ? { difficulty: filters.difficulty as 'easy' | 'medium' | 'hard' } : {}),
      },
      include: { ingredients: { include: { ingredient: true } } },
      orderBy: { title: 'asc' },
      take: 200,
    });
    return rows.map((r) => toRecipeDto(r));
  }

  async get(id: string): Promise<Recipe> {
    const row = await this.prisma.recipe.findUnique({
      where: { id },
      include: { ingredients: { include: { ingredient: true } } },
    });
    if (!row) throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    return toRecipeDto(row);
  }
}

/** Prisma recipe row (+ ingredients) → shared Recipe contract. */
export function toRecipeDto(row: {
  id: string;
  title: string;
  description: string;
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  steps: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  allergens: string[];
  origin: 'seed' | 'ai' | 'user';
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  reuseScore: number;
  ingredients: {
    ingredientId: string;
    quantity: number;
    unit: 'g' | 'ml' | 'piece';
    note: string | null;
    ingredient: { name: string };
  }[];
}): Recipe {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    servings: row.servings,
    mealTypes: row.mealTypes as Recipe['mealTypes'],
    dietTags: row.dietTags as Recipe['dietTags'],
    ingredients: row.ingredients.map((i) => ({
      ingredientId: i.ingredientId,
      name: i.ingredient.name,
      quantity: i.quantity,
      unit: i.unit,
      note: i.note,
    })),
    steps: row.steps,
    prepMinutes: row.prepMinutes,
    cookMinutes: row.cookMinutes,
    difficulty: row.difficulty,
    allergens: row.allergens as Recipe['allergens'],
    nutritionPerServing: {
      calories: row.caloriesPerServing,
      protein: row.proteinPerServing,
      fat: row.fatPerServing,
      carbs: row.carbsPerServing,
    },
    reuseScore: row.reuseScore,
    origin: row.origin,
  };
}
