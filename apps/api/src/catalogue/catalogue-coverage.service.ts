// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import type { DietType, MealType } from '@diet-app/shared';
import { macroReachByDiet, recipesPerDietAndMeal, type CoverageMatrix, type MacroReach } from '../engine/coverage.js';
import { amountsPerServing, requirementsPerServing } from '../engine/optimizer.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** How long a count is handed out again before the recipes are read anew. */
const KEPT_FOR_MS = 60_000;

/**
 * What the shared catalogue can serve right now: the recipes any user's plan
 * may draw on, counted per diet and meal. What a user made for themselves and
 * what an update retired are left out.
 */
@Injectable()
export class CatalogueCoverageService {
  private kept: { at: number; matrix: CoverageMatrix } | null = null;
  private counting: Promise<CoverageMatrix> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Counted now, and kept for those who ask next. */
  async count(): Promise<CoverageMatrix> {
    const recipes = await this.prisma.recipe.findMany({
      where: { createdByUserId: null, retiredAt: null, deletedAt: null },
      select: { dietTags: true, mealTypes: true },
    });
    const matrix = recipesPerDietAndMeal(recipes);
    this.kept = { at: Date.now(), matrix };
    return matrix;
  }

  /**
   * What the plans of each diet reach of the diet's split, and how much they
   * use of the packs that do not keep, with the recipes any user's plan may
   * draw on.
   */
  async macroReach(): Promise<Record<DietType, MacroReach | null>> {
    const recipes = await this.prisma.recipe.findMany({
      where: { createdByUserId: null, retiredAt: null, deletedAt: null },
      select: {
        id: true,
        servings: true,
        mealTypes: true,
        dietTags: true,
        caloriesPerServing: true,
        proteinPerServing: true,
        fatPerServing: true,
        carbsPerServing: true,
        ingredients: {
          select: {
            ingredientId: true,
            quantity: true,
            unit: true,
            ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true, packSize: true, perishable: true } },
          },
        },
      },
    });
    const perishablePacks = new Map<string, number>();
    for (const line of recipes.flatMap((recipe) => recipe.ingredients)) {
      if (line.ingredient.perishable && line.ingredient.packSize) perishablePacks.set(line.ingredientId, line.ingredient.packSize);
    }
    return macroReachByDiet(
      recipes.map(({ ingredients, mealTypes, servings, ...recipe }) => ({
        ...recipe,
        mealTypes: mealTypes as MealType[],
        ingredientIds: ingredients.map((line) => line.ingredientId),
        amounts: amountsPerServing(requirementsPerServing({ servings, ingredients })),
      })),
      perishablePacks,
    );
  }

  /**
   * As counted within the last minute. For the public configuration, which
   * every page asks for before anybody has signed in: however often it is
   * asked, the recipes are read once a minute, and once for all who ask at the
   * same moment.
   */
  recent(): Promise<CoverageMatrix> {
    if (this.kept && Date.now() - this.kept.at < KEPT_FOR_MS) return Promise.resolve(this.kept.matrix);
    this.counting ??= this.count().finally(() => {
      this.counting = null;
    });
    return this.counting;
  }
}
