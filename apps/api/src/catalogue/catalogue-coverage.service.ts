// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import type { DietType, MealType } from '@diet-app/shared';
import {
  macroReachByDiet,
  recipesPerDietAndMeal,
  type CoverageMatrix,
  type MacroReach,
} from '../engine/coverage.js';
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
  /** What the plans reached, and the state of the recipes they reached it with. */
  private reached: { with: string; reach: Record<DietType, MacroReach | null> } | null = null;

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
   * The recipe drafts that wait in the queue, counted like the recipes they
   * would become: those nobody rejected and that have not shipped yet.
   */
  async waiting(): Promise<CoverageMatrix> {
    return recipesPerDietAndMeal(
      await this.prisma.recipeDraft.findMany({
        where: { status: { in: ['PENDING', 'APPROVED'] } },
        select: { dietTags: true, mealTypes: true },
      }),
    );
  }

  /**
   * What the plans of each diet reach of the diet's split, and how much they
   * use of the packs that do not keep, with the recipes any user's plan may
   * draw on.
   *
   * The measure makes weeks of plans for every diet, which is work of this
   * process and holds up whoever else asks it something meanwhile. It is
   * therefore done once for the recipes as they are: the database keeps a
   * token that changes, in the same transaction, when anything the measure
   * reads changes, to the last amount, and while the token stays the same the
   * answer is the one kept. The token is read before the recipes, so that a
   * measure is never kept under a token newer than what it read.
   */
  async macroReach(): Promise<Record<DietType, MacroReach | null>> {
    const read = await this.catalogueVersion();
    if (read !== null && this.reached?.with === read) return this.reached.reach;

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
            ingredient: {
              select: {
                canonicalUnit: true,
                gramsPerPiece: true,
                density: true,
                packSize: true,
                perishable: true,
              },
            },
          },
        },
      },
    });
    const perishablePacks = new Map<string, number>();
    for (const line of recipes.flatMap((recipe) => recipe.ingredients)) {
      if (line.ingredient.perishable && line.ingredient.packSize)
        perishablePacks.set(line.ingredientId, line.ingredient.packSize);
    }
    const reach = macroReachByDiet(
      recipes.map(({ ingredients, mealTypes, servings, ...recipe }) => ({
        ...recipe,
        mealTypes: mealTypes as MealType[],
        ingredientIds: ingredients.map((line) => line.ingredientId),
        amounts: amountsPerServing(requirementsPerServing({ servings, ingredients })),
      })),
      perishablePacks,
    );
    this.reached = read === null ? null : { with: read, reach };
    return reach;
  }

  /**
   * The token of the shared recipes as they are: database triggers replace it
   * whenever a column `macroReach` reads changes in a shared recipe, in a line
   * of one or in an ingredient, whichever path writes. Null only where the row
   * is gone, and then nothing is kept.
   */
  private async catalogueVersion(): Promise<string | null> {
    const version = await this.prisma.catalogueVersion.findUnique({
      where: { id: 1 },
      select: { token: true },
    });
    return version?.token ?? null;
  }

  /**
   * As counted within the last minute. For the public configuration, which
   * every page asks for before anybody has signed in: however often it is
   * asked, the recipes are read once a minute, and once for all who ask at the
   * same moment.
   */
  recent(): Promise<CoverageMatrix> {
    if (this.kept && Date.now() - this.kept.at < KEPT_FOR_MS)
      return Promise.resolve(this.kept.matrix);
    this.counting ??= this.count().finally(() => {
      this.counting = null;
    });
    return this.counting;
  }
}
