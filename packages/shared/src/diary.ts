// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { DIARY_QUANTITY_LIMITS, MAX_DIARY_ENTRIES_A_DAY, OWN_MEAL_LIMITS } from './constants.js';
import { CalendarDay, DisplayAmount, MealType, Unit } from './enums.js';
import { EnteredNutrition, Nutrition } from './nutrition.js';

/**
 * The diary of a profile: what it ate on a day, planned or not.
 *
 * A day is the meals of the plan that holds it, as far as they are marked as
 * eaten, and the entries written for it: a recipe of the library or of the
 * account's own in servings, an ingredient of the catalogue in an amount, or a
 * meal of one's own by its figures. An entry keeps the figures worked out
 * when it was written, so that a later change of the catalogue does not
 * rewrite what was eaten. An entry changes nothing in a plan; a rebalance of
 * the plan's day counts the day's entries as eaten.
 */

/** What an entry is of. */
export const DiaryEntryKind = z.enum(['recipe', 'ingredient', 'meal']);
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

/** Whose diary, which day and which meal of it an entry is written for. A day still to come takes none. */
const EntryPlace = z.object({
  profileId: z.string().uuid(),
  date: CalendarDay,
  mealType: MealType,
});

/**
 * An entry written for a day: a recipe in servings, an ingredient of the
 * catalogue in an amount, or a meal of one's own by its figures.
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
 * for an ingredient. Its figures change in proportion to the amount.
 */
export const UpdateDiaryEntryRequest = z
  .object({
    mealType: MealType.optional(),
    servings: Servings.optional(),
    quantity: z.number().gt(0).max(5000).optional(),
  })
  .refine(
    (change) =>
      change.mealType !== undefined ||
      change.servings !== undefined ||
      change.quantity !== undefined,
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
   */
  name: z.string(),
  /** The recipe or the ingredient it is of, while they are there. */
  recipeId: z.string().uuid().nullable(),
  ingredientId: z.string().uuid().nullable(),
  /** Servings of a recipe or of a meal of one's own; null for an ingredient. */
  servings: z.number().nullable(),
  /**
   * The amount of an ingredient as it was given, and as a person reads it;
   * null for the other kinds.
   */
  amount: z.object({ quantity: z.number(), unit: Unit, shown: DisplayAmount }).nullable(),
  /** What it comes to, as it was worked out when it was written. */
  nutrition: Nutrition,
  /** Its macronutrients were estimated: a meal of one's own written by its energy. */
  estimated: z.boolean(),
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
  nutrition: Nutrition,
});
export type DiaryPlanMeal = z.infer<typeof DiaryPlanMeal>;

/** A day of a profile's diary. */
export const DiaryDay = z.object({
  profileId: z.string().uuid(),
  date: z.string().date(),
  /**
   * What the day aims at: the target of the plan's day where a plan holds it,
   * otherwise the profile's own.
   */
  target: Nutrition.extend({ from: z.enum(['plan', 'profile']) }),
  /**
   * The plan that holds the day, the one made last where several do, with
   * the day's meals as they are now. `offTarget` is where the plan's day
   * stands with the entries counted as eaten, as its rebalance counts them.
   * Null on a day no plan holds.
   */
  plan: z
    .object({
      id: z.string().uuid(),
      skipped: z.boolean(),
      meals: z.array(DiaryPlanMeal),
      calorieDelta: z.number(),
      offTarget: z.enum(['over', 'under']).nullable(),
    })
    .nullable(),
  /** The entries of the day, under the meals they were written for, the first written first. */
  entries: z.array(DiaryEntry).max(MAX_DIARY_ENTRIES_A_DAY),
  /** What was eaten: the plan's meals marked as eaten, and every entry. */
  eaten: Nutrition,
  /** A figure of what was eaten is estimated. */
  estimated: z.boolean(),
});
export type DiaryDay = z.infer<typeof DiaryDay>;

/**
 * Copy what was eaten on one day into another: the entries of `from`, and
 * the meals its plan marked as eaten, which come in as entries. Nothing is
 * copied when the day it goes to would hold more than the most.
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
