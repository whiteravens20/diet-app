// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Locale, Macros, ProductSource, Unit } from '@diet-app/shared';
import { labelOfAmount, toStoredLabel, type StoredLabel } from '../engine/label-totals.js';
import {
  labelEntryFigures,
  nutritionFor,
  toCanonical,
  UnitConversionError,
  type LabelEntryFigures,
} from '../engine/index.js';
import { pickIngredient } from '../recipes/recipes.service.js';
import { languages } from './diary-entries.js';

/**
 * A food chosen from the catalogue or from a label, as an entry of the diary and a meal of one's own added to a plan
 * hold it: its name, worked out now, and its figures for the amount eaten. One source for both, so that a product
 * comes to the same in the diary and in a plan.
 */

type Db = Pick<Prisma.TransactionClient, 'ingredient' | 'product' | 'ownProduct'>;

/** An ingredient of the catalogue in an amount: its name in `locale` and what the amount holds. */
export interface IngredientEaten {
  name: string;
  figures: { calories: number; protein: number; fat: number; carbs: number } & StoredLabel;
}

/**
 * `amount` of an ingredient of the catalogue still offered: 404 `INGREDIENT_NOT_FOUND` for one retired or gone, 400
 * `DIARY_UNIT_NOT_CONVERTIBLE` for an amount in a unit it cannot be given in.
 */
export async function ingredientEaten(
  db: Db,
  locale: Locale,
  ingredientId: string,
  amount: { quantity: number; unit: Unit },
): Promise<IngredientEaten> {
  const ingredient = await db.ingredient.findFirst({
    where: { id: ingredientId, retiredAt: null },
    select: {
      name: true,
      canonicalUnit: true,
      gramsPerPiece: true,
      density: true,
      caloriesPer100: true,
      proteinPer100: true,
      fatPer100: true,
      carbsPer100: true,
      fiberPer100: true,
      sugarsPer100: true,
      saltPer100: true,
      saturatedFatPer100: true,
      translations: {
        where: { locale: { in: languages(locale) } },
        select: { locale: true, name: true },
      },
    },
  });
  if (!ingredient) {
    throw new NotFoundException({
      error: 'INGREDIENT_NOT_FOUND',
      message: 'Ingredient not found.',
    });
  }
  let canonical: number;
  try {
    canonical = toCanonical(amount.quantity, amount.unit, ingredient);
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    throw new BadRequestException({
      error: 'DIARY_UNIT_NOT_CONVERTIBLE',
      message: `This ingredient cannot be given in ${amount.unit}: use one of the units it is offered in.`,
    });
  }
  return {
    name: pickIngredient(locale, ingredient.translations, ingredient.name),
    figures: {
      ...nutritionFor(canonical, {
        calories: ingredient.caloriesPer100,
        protein: ingredient.proteinPer100,
        fat: ingredient.fatPer100,
        carbs: ingredient.carbsPer100,
      }),
      ...toStoredLabel(labelOfAmount(ingredient, canonical)),
    },
  };
}

/** A product of the base or of the account's own in an amount: which it is, its name and what the amount holds. */
export interface ProductEaten {
  /** The base's product, or null for one of the account's own. */
  productId: string | null;
  ownProductId: string | null;
  source: ProductSource;
  name: string;
  /** The unit its label is given in. */
  unit: Unit;
  figures: LabelEntryFigures;
}

/**
 * `quantity` of a product, the base's or one of `userId`'s own, which nobody else's request can reach: 404
 * `PRODUCT_NOT_FOUND` for none; 409 `PRODUCT_WITHOUT_FIGURES` for a label without energy. A macronutrient the label
 * lacks is estimated in the proportions of `split`.
 */
export async function productEaten(
  db: Db,
  userId: string,
  productId: string,
  quantity: number,
  split: Macros,
): Promise<ProductEaten> {
  const base = await db.product.findUnique({ where: { id: productId } });
  const own = base ? null : await db.ownProduct.findFirst({ where: { id: productId, userId } });
  const product = base ?? (own && { ...own, energyWorkedOut: false });
  if (!product) {
    throw new NotFoundException({
      error: 'PRODUCT_NOT_FOUND',
      message: 'No product with this code is known.',
    });
  }
  const figures = labelEntryFigures(product, quantity, split);
  if (!figures) {
    throw new ConflictException({
      error: 'PRODUCT_WITHOUT_FIGURES',
      message: 'The label of this product gives no energy: write it as a meal of your own.',
    });
  }
  return {
    productId: base ? productId : null,
    ownProductId: own ? productId : null,
    source: own ? 'own' : base?.origin === 'accepted' ? 'instance' : 'open_food_facts',
    name: product.brand ? `${product.name}, ${product.brand}` : product.name,
    unit: product.unit,
    figures,
  };
}
