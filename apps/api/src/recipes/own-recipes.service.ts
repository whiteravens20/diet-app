// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Allergen,
  DietType,
  Locale,
  OwnRecipeInput,
  OwnRecipeLine,
  OwnRecipePreview,
  OwnRecipePreviewRequest,
  Recipe,
} from '@diet-app/shared';
import type { Ingredient } from '@prisma/client';
import { recipeFacts, UnitConversionError, type RecipeFacts } from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PersonalRecipesService, type PersonalRecipe } from './personal-recipes.service.js';
import { checkRecipe, type RecipeProblem } from './recipe-rules.js';
import { RecipesService } from './recipes.service.js';

/**
 * Recipes a user writes by hand, and the new versions they make by editing a
 * recipe of theirs. The text is in the language of the request and in that
 * one only; the ingredients are the catalogue's, and the engine works out the
 * nutrition, the allergens and the diets from them, as it does for every
 * recipe. The rules every recipe is held to apply here too. A recipe is
 * stored the way `PersonalRecipesService.saveOwn` describes: it is its
 * owner's alone until they submit it.
 */
@Injectable()
export class OwnRecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly personal: PersonalRecipesService,
    private readonly recipes: RecipesService,
  ) {}

  /** What a serving of these ingredients would hold. Nothing is stored. */
  async preview(req: OwnRecipePreviewRequest): Promise<OwnRecipePreview> {
    const ingredients = await this.ingredientsOf(req.ingredients);
    const facts = factsOf(
      req.ingredients.map((line, index) => ({ ...line, ingredient: ingredients[index]! })),
      req.servings,
    );
    return {
      nutritionPerServing: facts.perServing,
      allergens: facts.allergens as Allergen[],
      dietTags: facts.dietTags as DietType[],
    };
  }

  /** Write a recipe of the user's own. */
  async create(userId: string, locale: Locale, input: OwnRecipeInput): Promise<Recipe> {
    const recipe = await this.recipeOf(userId, locale, input, {
      origin: 'manual',
      edited: false,
      modelAssisted: false,
    });
    return this.recipes.get(userId, locale, await this.personal.saveOwn(recipe));
  }

  /**
   * Edit a recipe of the user's own, whoever wrote it: the new version is
   * written by hand. One made by swapping an ingredient stays one, and so
   * stays its owner's; one a model had a part in keeps the mark of it.
   */
  async edit(userId: string, locale: Locale, id: string, input: OwnRecipeInput): Promise<Recipe> {
    const old = await this.prisma.recipe.findUnique({
      where: { id },
      select: { createdByUserId: true, deletedAt: true, origin: true, modelAssisted: true },
    });
    if (!old || old.deletedAt || old.createdByUserId !== userId) {
      throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    }
    const recipe = await this.recipeOf(userId, locale, input, {
      origin: old.origin === 'swap' ? 'swap' : 'manual',
      edited: true,
      modelAssisted: old.modelAssisted || old.origin === 'ai',
    });
    return this.recipes.get(userId, locale, await this.personal.saveOwn(recipe, id));
  }

  /** The recipe to store: the input held to the rules of every recipe, with what the engine works out. */
  private async recipeOf(
    userId: string,
    locale: Locale,
    input: OwnRecipeInput,
    kind: Pick<PersonalRecipe, 'origin' | 'edited' | 'modelAssisted'>,
  ): Promise<PersonalRecipe> {
    const ingredients = await this.ingredientsOf(input.ingredients);
    const checked = checkRecipe(
      {
        titles: { [locale]: input.title },
        descriptions: { [locale]: input.description },
        steps: { [locale]: input.steps },
        servings: input.servings,
        mealTypes: input.mealTypes,
        prepMinutes: input.prepMinutes,
        cookMinutes: input.cookMinutes,
        difficulty: input.difficulty,
        ingredients: input.ingredients.map((line, index) => ({
          slug: ingredients[index]!.slug,
          quantity: line.quantity,
          unit: line.unit,
          note: line.note,
        })),
      },
      [locale],
    );
    if (!checked.ok) throw invalid(checked.problems);
    const { recipe } = checked;
    return {
      userId,
      ...kind,
      text: new Map([
        [
          locale,
          {
            title: recipe.titles[locale]!,
            description: recipe.descriptions[locale]!,
            steps: recipe.steps[locale]!,
          },
        ],
      ]),
      servings: recipe.servings,
      mealTypes: recipe.mealTypes,
      prepMinutes: recipe.prepMinutes,
      cookMinutes: recipe.cookMinutes,
      difficulty: recipe.difficulty,
      cuisine: input.cuisine,
      ingredients: recipe.ingredients.map((line, index) => ({
        ingredientId: ingredients[index]!.id,
        quantity: line.quantity,
        unit: line.unit,
        note: line.note,
      })),
      facts: factsOf(
        recipe.ingredients.map((line, index) => ({ ...line, ingredient: ingredients[index]! })),
        recipe.servings,
      ),
    };
  }

  /**
   * The ingredient of each line, in the order of the lines: one of the
   * catalogue that is not retired, and that a recipe can name.
   */
  private async ingredientsOf(lines: readonly OwnRecipeLine[]): Promise<Ingredient[]> {
    const rows = await this.prisma.ingredient.findMany({
      where: {
        id: { in: lines.map((line) => line.ingredientId) },
        retiredAt: null,
        slug: { not: null },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return lines.map((line) => {
      const row = byId.get(line.ingredientId);
      if (!row) {
        throw new NotFoundException({
          error: 'INGREDIENT_NOT_FOUND',
          message: 'Ingredient not found.',
        });
      }
      return row;
    });
  }
}

/** What the engine works out for these lines; a unit an ingredient cannot be measured in is refused. */
function factsOf(
  lines: readonly { quantity: number; unit: OwnRecipeLine['unit']; ingredient: Ingredient }[],
  servings: number,
): RecipeFacts {
  try {
    return recipeFacts(lines, servings);
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    throw new BadRequestException({
      error: 'UNIT_CONVERSION_FAILED',
      message: 'An ingredient is measured in a unit it cannot be converted from.',
    });
  }
}

/** The refusal of a recipe that breaks the rules of every recipe: each problem by its place and its rule. */
function invalid(problems: RecipeProblem[]): BadRequestException {
  return new BadRequestException({
    error: 'RECIPE_INVALID',
    message: `The recipe would break ${problems.length === 1 ? 'a rule' : `${problems.length} rules`}: ${problems.map((problem) => problem.message).join('; ')}.`,
    details: { problems },
  });
}
