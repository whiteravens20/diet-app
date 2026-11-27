// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import {
  DIARY_QUANTITY_LIMITS,
  MAX_DIARY_ENTRIES_A_DAY,
  MAX_DIARY_ENTRIES_KEPT,
  MAX_OTHER_PLAN_MEALS_A_DAY,
  OWN_MEAL_LIMITS,
} from './constants.js';
import { CalendarDay, DisplayAmount, MealType, Unit } from './enums.js';
import {
  EnteredNutrition,
  LabelLimitNote,
  LabelNutrient,
  LabelTotals,
  Nutrition,
  TargetMacros,
} from './nutrition.js';
import { LabelNutrients, ProductSource } from './product.js';

/**
 * The diary of a profile: what it ate on a day, planned or not.
 *
 * A day is the meals of the plan that holds it, as far as they are marked as
 * eaten, and the entries written for it: a recipe of the library or of the
 * account's own in servings, an ingredient of the catalogue in an amount, a
 * product with a barcode in an amount, or a meal of one's own by its figures.
 * An entry keeps the figures worked out when it was written, so that a later
 * change of the catalogue or of a label does not rewrite what was eaten. An entry changes nothing in a plan; a rebalance of
 * the plan's day, and whatever fills it again, counts the day's entries as
 * eaten.
 */

/** What an entry is of. */
export const DiaryEntryKind = z.enum(['recipe', 'ingredient', 'product', 'meal']);
export type DiaryEntryKind = z.infer<typeof DiaryEntryKind>;

/** Servings of a recipe or of a meal of one's own, as an entry holds them. */
const Servings = z.number().min(OWN_MEAL_LIMITS.servings.min).max(OWN_MEAL_LIMITS.servings.max);

/** An amount of an ingredient, at most what `DIARY_QUANTITY_LIMITS` allows in its unit. */
const IngredientAmount = z
  .object({ quantity: z.number().gt(0).max(5000), unit: Unit })
  .refine((amount) => amount.quantity <= DIARY_QUANTITY_LIMITS[amount.unit], {
    path: ['quantity'],
    message: 'More than a day holds of one food in this unit.',
  });

/**
 * What a meal of one's own added to a plan is of, chosen as an entry of the diary is (`CreateDiaryEntryRequest`): a
 * recipe of the library or of the account's own in servings, an ingredient of the catalogue in an amount, or a
 * product (the base's or one's own) in grams or millilitres (`AddCustomMealRequest.of`).
 */
export const CustomMealOf = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recipe'), recipeId: z.string().uuid(), servings: Servings }),
  z.object({
    kind: z.literal('ingredient'),
    ingredientId: z.string().uuid(),
    amount: IngredientAmount,
  }),
  z.object({
    kind: z.literal('product'),
    productId: z.string().uuid(),
    quantity: z.number().gt(0).max(DIARY_QUANTITY_LIMITS.g),
  }),
]);
export type CustomMealOf = z.infer<typeof CustomMealOf>;

/**
 * The figures of one serving of a meal of one's own: its energy, and of the
 * macronutrients those that are known. The ones left out are estimated from
 * what is left of the energy, in the proportions of the day's target, and the
 * entry says that they were.
 */
export const DiaryMealNutrition = z.object({
  calories: EnteredNutrition.shape.calories,
  protein: EnteredNutrition.shape.protein.optional(),
  fat: EnteredNutrition.shape.fat.optional(),
  carbs: EnteredNutrition.shape.carbs.optional(),
});
export type DiaryMealNutrition = z.infer<typeof DiaryMealNutrition>;

/** A macronutrient of a meal of one's own that was estimated from its energy, not given. */
export const EstimatedMacro = z.enum(['protein', 'fat', 'carbs']);
export type EstimatedMacro = z.infer<typeof EstimatedMacro>;

/** Whose diary, which day and which meal of it an entry is written for. A day still to come takes none. */
const EntryPlace = z.object({
  profileId: z.string().uuid(),
  date: CalendarDay,
  mealType: MealType,
});

/**
 * An entry written for a day: a recipe in servings, an ingredient of the
 * catalogue in an amount, a product in grams or millilitres, whichever it is
 * measured in, or a meal of one's own by its figures.
 */
export const CreateDiaryEntryRequest = z.discriminatedUnion('kind', [
  EntryPlace.extend({
    kind: z.literal('recipe'),
    recipeId: z.string().uuid(),
    servings: Servings,
  }),
  EntryPlace.extend({
    kind: z.literal('ingredient'),
    ingredientId: z.string().uuid(),
    amount: IngredientAmount,
  }),
  EntryPlace.extend({
    kind: z.literal('product'),
    productId: z.string().uuid(),
    quantity: z.number().gt(0).max(DIARY_QUANTITY_LIMITS.g),
  }),
  EntryPlace.extend({
    kind: z.literal('meal'),
    name: z.string().trim().min(1).max(OWN_MEAL_LIMITS.name),
    servings: Servings.default(1),
    nutrition: DiaryMealNutrition,
  }),
]);
export type CreateDiaryEntryRequest = z.infer<typeof CreateDiaryEntryRequest>;

/**
 * A change of an entry: the meal it is under, and how much of it there was:
 * servings for a recipe or a meal of one's own, a quantity in its own unit
 * for an ingredient or a product. Its figures change in proportion to the
 * amount. A meal of one's own also takes its name and the figures of a
 * serving anew.
 */
export const UpdateDiaryEntryRequest = z
  .object({
    mealType: MealType.optional(),
    servings: Servings.optional(),
    quantity: z.number().gt(0).max(5000).optional(),
    /** For a meal of one's own: what it is called. */
    name: z.string().trim().min(1).max(OWN_MEAL_LIMITS.name).optional(),
    /**
     * For a meal of one's own: the figures of one serving. Its energy, and of
     * the macronutrients those given now; one sent as null is estimated from
     * the energy, one not named stays given where it was given and is
     * estimated again from the new energy where it was estimated.
     */
    nutrition: DiaryMealNutrition.extend({
      protein: EnteredNutrition.shape.protein.nullable().optional(),
      fat: EnteredNutrition.shape.fat.nullable().optional(),
      carbs: EnteredNutrition.shape.carbs.nullable().optional(),
    }).optional(),
    /**
     * For an entry of a product: a product of the reader's own it is of from
     * now on, whose label gives its figures for the same amount, as when its
     * reader corrects what the base says.
     */
    productId: z.string().uuid().optional(),
  })
  .refine(
    (change) =>
      change.mealType !== undefined ||
      change.servings !== undefined ||
      change.quantity !== undefined ||
      change.productId !== undefined ||
      change.name !== undefined ||
      change.nutrition !== undefined,
    { message: 'Name at least one thing to change.' },
  );
export type UpdateDiaryEntryRequest = z.infer<typeof UpdateDiaryEntryRequest>;

/** An entry of a diary, as the day shows it. */
export const DiaryEntry = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  date: z.string().date(),
  mealType: MealType,
  kind: DiaryEntryKind,
  /**
   * What it is: the recipe's title or the ingredient's name in the reader's
   * language while it is there, otherwise the name it had when it was written.
   * A product is called what it was called when the entry was written.
   */
  name: z.string(),
  /** The recipe or the ingredient it is of, while they are there. */
  recipeId: z.string().uuid().nullable(),
  ingredientId: z.string().uuid().nullable(),
  /** The product it is of, while the instance holds it. */
  productId: z.string().uuid().nullable(),
  /** The code of that product, where it has one: what a correction of it is written for. */
  productCode: z.string().nullable(),
  /** Where the figures of a product came from when it was written; null for the other kinds. */
  productSource: ProductSource.nullable(),
  /** Servings of a recipe or of a meal of one's own; null for an ingredient or a product. */
  servings: z.number().nullable(),
  /**
   * The amount of an ingredient or a product as it was given, and the same
   * amount in the words a person reads it in, a piece by what the ingredient
   * calls it; null for the other kinds.
   */
  amount: z.object({ quantity: z.number(), unit: Unit, shown: DisplayAmount }).nullable(),
  /** What it comes to, as it was worked out when it was written. */
  nutrition: Nutrition,
  /**
   * Fibre, sugars, salt and saturated fat of the amount, as they were worked out when it was
   * written: a product's from its label, a recipe's or an ingredient's from the catalogue. Null for
   * a meal of one's own, and for an entry written before the catalogue held them that its recipe
   * or ingredient no longer gives them for.
   */
  label: LabelNutrients.nullable(),
  /** Those of them that are only a part of what it holds: of a recipe one of whose ingredients lacks it. */
  labelAtLeast: z.array(LabelNutrient).max(LabelNutrient.options.length),
  /** A figure was estimated: of a meal written by its energy, or of a product whose label lacks it. */
  estimated: z.boolean(),
  /** Of a meal of one's own, the macronutrients that were estimated from its energy; empty for the other kinds. */
  estimatedMacros: z.array(EstimatedMacro).max(EstimatedMacro.options.length),
  createdAt: z.string().datetime(),
});
export type DiaryEntry = z.infer<typeof DiaryEntry>;

/** Whose day, and which. */
export const DiaryDayQuery = z.object({ profileId: z.string().uuid(), date: CalendarDay });
export type DiaryDayQuery = z.infer<typeof DiaryDayQuery>;

/** A meal of the plan that holds the day, as the diary shows it. */
export const DiaryPlanMeal = z.object({
  id: z.string().uuid(),
  mealType: MealType,
  /** The recipe's title in the reader's language, or the name of a meal of one's own. */
  name: z.string(),
  /** The recipe it is of; null for a meal of one's own. */
  recipeId: z.string().uuid().nullable(),
  eaten: z.boolean(),
  /** What the meal holds, its topping (`topping`) with it: it is eaten with the meal. */
  nutrition: Nutrition,
  /** Fibre, sugars, salt and saturated fat of the meal, its topping with it. */
  label: LabelTotals,
  /** What is put on this meal's plate alone beside a dish of a joint plan, named and as it is measured; null where there is none. */
  topping: z.object({ name: z.string(), display: DisplayAmount }).nullable(),
  /**
   * A meal of a joint plan cooked in one pot and split by weight: its figures
   * are this person's planned portion, which a split comes only near, so they
   * are shown as an estimate. False for every other meal, one cooked apart too.
   */
  fromPot: z.boolean(),
});
export type DiaryPlanMeal = z.infer<typeof DiaryPlanMeal>;

/**
 * A meal marked eaten on a day in another plan of the profile that holds the day, not the one a reader
 * shows for it: what was eaten counts whichever plan it came from. With the plan it is of.
 */
export const EatenInOtherPlan = DiaryPlanMeal.extend({ planId: z.string().uuid() });
export type EatenInOtherPlan = z.infer<typeof EatenInOtherPlan>;

/** A day of a profile's diary. */
export const DiaryDay = z.object({
  profileId: z.string().uuid(),
  date: z.string().date(),
  /**
   * What the day aims at: the target of the plan's day where a plan holds it
   * and does not skip it, otherwise the profile's own, on a day gone as it
   * stood on the day. A day gone of a plan since removed keeps its plan's
   * day's target (`from` 'plan').
   */
  target: Nutrition.extend({
    from: z.enum(['plan', 'profile']),
    /** As `TargetMacros` has it: the least carbohydrate a diet whose carbohydrate is a ceiling holds the day to; fat is then what protein and the day's carbohydrate leave. */
    carbsFloor: TargetMacros.shape.carbsFloor,
  }),
  /**
   * The plan that holds the day, the one made last where several do, with
   * the day's meals as they are now. `offTarget` is where the plan's day
   * stands with the entries counted as eaten, as its rebalance counts them.
   * Null on a day no plan holds.
   */
  plan: z
    .object({
      id: z.string().uuid(),
      /** The plan's day: its history (`DayHistory`) is read by it. */
      dayId: z.string().uuid(),
      skipped: z.boolean(),
      meals: z.array(DiaryPlanMeal),
      calorieDelta: z.number(),
      offTarget: z.enum(['over', 'under']).nullable(),
      /** `MealPlanDay.resizes` of the same day: whether sizing it again would give a meal another portion. */
      resizes: z.boolean(),
    })
    .nullable(),
  /**
   * The entries of the day, under the meals they were written for, the first written first. Beside the
   * `MAX_DIARY_ENTRIES_A_DAY` written into it, a day holds the meals eaten from plans removed since.
   */
  entries: z.array(DiaryEntry).max(MAX_DIARY_ENTRIES_KEPT),
  /** The meals marked eaten on the day in the profile's other plans that hold it, under their times of day. */
  otherPlans: z.array(EatenInOtherPlan).max(MAX_OTHER_PLAN_MEALS_A_DAY),
  /** What was eaten: the meals marked as eaten in the plan and in the profile's other plans, and every entry. */
  eaten: Nutrition,
  /** Fibre, sugars, salt and saturated fat of the same. */
  eatenLabel: LabelTotals,
  /** The limits of the profile that what was eaten crosses. */
  labelNotes: z.array(LabelLimitNote).max(LabelNutrient.options.length),
  /** A figure of what was eaten is estimated. */
  estimated: z.boolean(),
});
export type DiaryDay = z.infer<typeof DiaryDay>;

/**
 * Copy what was eaten on one day into another: the entries of `from`, and
 * the meals marked as eaten that day in the profile's plans, which come in as
 * entries. Nothing is copied when the day it goes to would hold more than the
 * most.
 */
export const CopyDiaryDayRequest = z
  .object({ profileId: z.string().uuid(), from: CalendarDay, to: CalendarDay })
  .refine((copy) => copy.from !== copy.to, {
    path: ['to'],
    message: 'A day cannot be copied into itself.',
  });
export type CopyDiaryDayRequest = z.infer<typeof CopyDiaryDayRequest>;

/** What a copy did: how many entries it wrote into the day, and the day as it is now. */
export const DiaryCopyResult = z.object({
  copied: z.number().int().min(0).max(MAX_DIARY_ENTRIES_A_DAY),
  day: DiaryDay,
});
export type DiaryCopyResult = z.infer<typeof DiaryCopyResult>;
