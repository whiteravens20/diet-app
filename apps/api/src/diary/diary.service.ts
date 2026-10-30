// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DIARY_QUANTITY_LIMITS,
  MAX_DIARY_ENTRIES_A_DAY,
  type CopyDiaryDayRequest,
  type CreateDiaryEntryRequest,
  type DiaryCopyResult,
  type DiaryDay,
  type DiaryEntry,
  type DiaryPlanMeal,
  type Locale,
  type Macros,
  type MealType,
  type UpdateDiaryEntryRequest,
} from '@diet-app/shared';
import { holdProfile } from '../common/hold.js';
import { writeOnce } from '../common/idempotency.js';
import { storedSplit } from '../common/stored-split.js';
import {
  calculateCalories,
  displayAmount,
  estimatedMacros,
  macroSplitOf,
  macrosForCalories,
  nutritionFor,
  scaledFigures,
  sharesOf,
  toCanonical,
  UnitConversionError,
} from '../engine/index.js';
import { mealRank } from '../meal-plans/meal-plans.service.js';
import {
  customMacros,
  isoDate,
  isSkipped,
  mealNutrition,
  standingOf,
  sumNutrition,
} from '../meal-plans/plan-days.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calorieInputOf } from '../profiles/calorie-input.js';
import { pickIngredient, pickTitle } from '../recipes/recipes.service.js';
import { wholeFigures } from './diary-days.js';

/** Energy and the three macronutrients, in kcal and grams. */
type Figures = Macros & { calories: number };

/** What the diary reads of a profile: whose it is, and what its own target is worked out from. */
const PROFILE = {
  id: true,
  userId: true,
  age: true,
  sex: true,
  heightCm: true,
  weightKg: true,
  activityLevel: true,
  dietType: true,
  customMacroSplit: true,
  weeklyLossTarget: true,
  manualCalorieTarget: true,
  riskAcknowledgedAt: true,
} as const;
type DiaryProfile = Prisma.ProfileGetPayload<{ select: typeof PROFILE }>;

/** The languages a name is read in: the reader's, and English where it has none in it. */
const languages = (locale: Locale): string[] => (locale === 'en' ? ['en'] : [locale, 'en']);

/** Of the plans that hold a day, the one made last: as the calendar picks it. */
const MADE_LAST = [{ plan: { createdAt: 'desc' } }, { planId: 'asc' }] as const;

/** What an entry is read with: the recipe or the ingredient it is of, named in the reader's language. */
const entryWith = (locale: Locale) =>
  ({
    recipe: {
      select: {
        title: true,
        deletedAt: true,
        translations: {
          where: { locale: { in: languages(locale) } },
          select: { locale: true, title: true },
        },
      },
    },
    ingredient: {
      select: {
        name: true,
        canonicalUnit: true,
        gramsPerPiece: true,
        density: true,
        displayUnit: true,
        perTeaspoon: true,
        translations: {
          where: { locale: { in: languages(locale) } },
          select: { locale: true, name: true },
        },
      },
    },
  }) satisfies Prisma.DiaryEntryInclude;
type EntryRow = Prisma.DiaryEntryGetPayload<{ include: ReturnType<typeof entryWith> }>;

/** What an entry holds besides where it is: what it is of, its name, its amount and its figures. */
type Written = Pick<
  Prisma.DiaryEntryUncheckedCreateInput,
  'kind' | 'recipeId' | 'ingredientId' | 'name' | 'servings' | 'quantity' | 'unit' | 'estimated'
> &
  Figures;

/**
 * The diary of a profile: what it ate on a day, the meals its plan marks as
 * eaten and the entries written for the day. An entry keeps the figures
 * worked out when it was written. It changes nothing in a plan; a day of a
 * plan counts the day's entries as eaten (`diary-days.ts`).
 */
@Injectable()
export class DiaryService {
  constructor(private readonly prisma: PrismaService) {}

  /** A day of a profile's diary, with what it aims at and, where a plan holds it, the plan's meals. */
  async day(userId: string, locale: Locale, profileId: string, date: string): Promise<DiaryDay> {
    const profile = await this.profile(userId, profileId);
    const [planDay, rows] = await Promise.all([
      this.prisma.mealPlanDay.findFirst({
        where: { date: new Date(date), plan: { profileId } },
        orderBy: [...MADE_LAST],
        select: {
          planId: true,
          calorieTarget: true,
          overrides: true,
          plan: { select: { dietType: true, macroSplit: true } },
          meals: {
            select: {
              id: true,
              mealType: true,
              servings: true,
              quantityScale: true,
              source: true,
              customName: true,
              customMacros: true,
              eatenAt: true,
              recipe: {
                select: {
                  id: true,
                  title: true,
                  caloriesPerServing: true,
                  proteinPerServing: true,
                  fatPerServing: true,
                  carbsPerServing: true,
                  translations: {
                    where: { locale: { in: languages(locale) } },
                    select: { locale: true, title: true },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.diaryEntry.findMany({
        where: { profileId, date: new Date(date) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: entryWith(locale),
      }),
    ]);

    const fromEntries = wholeFigures(
      rows.reduce(
        (sum, row) => ({
          calories: sum.calories + row.calories,
          protein: sum.protein + row.protein,
          fat: sum.fat + row.fat,
          carbs: sum.carbs + row.carbs,
        }),
        { calories: 0, protein: 0, fat: 0, carbs: 0 },
      ),
    );
    const entered = rows.length > 0 ? [fromEntries] : [];
    const meals: DiaryPlanMeal[] = [...(planDay?.meals ?? [])]
      .sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType))
      .map((meal) => ({
        id: meal.id,
        mealType: meal.mealType as MealType,
        name:
          meal.source === 'USER_CUSTOM' || !meal.recipe
            ? (meal.customName ?? '')
            : pickTitle(locale, meal.recipe.translations, meal.recipe.title),
        recipeId: meal.source === 'USER_CUSTOM' ? null : (meal.recipe?.id ?? null),
        eaten: meal.eatenAt !== null,
        nutrition: mealNutrition(meal),
      }));
    const skipped = planDay ? isSkipped(planDay) : false;
    // Where the plan's day stands is where its view says it stands: its meals, and the entries as eaten.
    const planned = sumNutrition([...meals.map((meal) => meal.nutrition), ...entered]);
    return {
      profileId,
      date,
      target: this.aimOf(profile, planDay).target,
      plan: planDay
        ? {
            id: planDay.planId,
            skipped,
            meals,
            ...standingOf(planned.calories, planDay.calorieTarget, skipped),
          }
        : null,
      entries: rows.map((row) => this.toDto(row, locale)),
      eaten: sumNutrition([
        ...meals.filter((meal) => meal.eaten).map((meal) => meal.nutrition),
        ...entered,
      ]),
      estimated: rows.some((row) => row.estimated),
    };
  }

  /**
   * Write an entry for a day of today or before it (`today` is the client's
   * day). A day holds at most `MAX_DIARY_ENTRIES_A_DAY`, counted while the
   * profile is held. Sent again with its key, the request is answered with
   * the entry the first one wrote, and writes nothing.
   */
  create(
    userId: string,
    locale: Locale,
    req: CreateDiaryEntryRequest,
    key: string | null,
    today: string | null,
  ): Promise<DiaryEntry> {
    this.refuseDayAhead(req.date, today);
    return writeOnce(this.prisma, {
      userId,
      key,
      route: 'POST /diary/entries',
      request: req,
      write: async (keep) => {
        const profile = await this.profile(userId, req.profileId);
        const written = await this.written(userId, locale, profile, req);
        const id = await this.prisma.$transaction(async (tx) => {
          await this.makeRoom(tx, req.profileId, req.date, 1);
          const row = await tx.diaryEntry.create({
            data: {
              profileId: req.profileId,
              date: new Date(req.date),
              mealType: req.mealType,
              ...written,
            },
            select: { id: true },
          });
          await keep(tx, row.id);
          return row.id;
        });
        return this.entry(userId, locale, id);
      },
      replay: (id) => this.entry(userId, locale, id),
    });
  }

  /**
   * Change an entry: the meal it is under, and how much of it there was. Its
   * figures change in proportion to the amount, so that what they were worked
   * out from when it was written still holds.
   */
  async update(
    userId: string,
    locale: Locale,
    id: string,
    change: UpdateDiaryEntryRequest,
  ): Promise<DiaryEntry> {
    const row = await this.prisma.diaryEntry.findFirst({ where: { id, profile: { userId } } });
    if (!row) throw entryNotFound();
    const ingredient = row.kind === 'ingredient';
    if (change.servings !== undefined && ingredient)
      throw refused('servings', 'An entry of an ingredient takes a quantity, not servings.');
    if (change.quantity !== undefined && !ingredient)
      throw refused('quantity', 'Only an entry of an ingredient takes a quantity.');
    if (change.quantity !== undefined && change.quantity > DIARY_QUANTITY_LIMITS[row.unit!])
      throw refused('quantity', `More than a day holds of one food in ${row.unit}.`);
    const factor =
      change.servings !== undefined
        ? change.servings / row.servings!
        : change.quantity !== undefined
          ? change.quantity / row.quantity!
          : 1;
    const changed = await this.prisma.diaryEntry.updateMany({
      where: { id, profile: { userId } },
      data: {
        mealType: change.mealType,
        servings: change.servings,
        quantity: change.quantity,
        ...scaledFigures(row, factor),
      },
    });
    if (changed.count === 0) throw entryNotFound();
    return this.entry(userId, locale, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    // An entry of somebody else's profile is answered as one that is not there.
    const removed = await this.prisma.diaryEntry.deleteMany({
      where: { id, profile: { userId } },
    });
    if (removed.count === 0) throw entryNotFound();
  }

  /**
   * Copy what was eaten on one day into another of today or before it: the
   * entries of `from`, and the meals its plan marked as eaten, which come in
   * as entries with their figures as they are now. Nothing is copied when the
   * day it goes to would hold more than the most. Sent again with its key,
   * the request is answered with the day as it is now, and copies nothing.
   */
  copy(
    userId: string,
    locale: Locale,
    req: CopyDiaryDayRequest,
    key: string | null,
    today: string | null,
  ): Promise<DiaryCopyResult> {
    this.refuseDayAhead(req.to, today);
    const { profileId, from, to } = req;
    return writeOnce(this.prisma, {
      userId,
      key,
      route: 'POST /diary/copy',
      request: req,
      write: async (keep) => {
        await this.profile(userId, profileId);
        const [entries, planDay] = await Promise.all([
          this.prisma.diaryEntry.findMany({
            where: { profileId, date: new Date(from) },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
          this.prisma.mealPlanDay.findFirst({
            where: { date: new Date(from), plan: { profileId } },
            orderBy: [...MADE_LAST],
            select: {
              meals: {
                where: { eatenAt: { not: null } },
                select: {
                  mealType: true,
                  servings: true,
                  quantityScale: true,
                  source: true,
                  customName: true,
                  customMacros: true,
                  recipe: {
                    select: {
                      id: true,
                      title: true,
                      caloriesPerServing: true,
                      proteinPerServing: true,
                      fatPerServing: true,
                      carbsPerServing: true,
                      translations: {
                        where: { locale: { in: languages(locale) } },
                        select: { locale: true, title: true },
                      },
                    },
                  },
                },
              },
            },
          }),
        ]);
        const eaten = [...(planDay?.meals ?? [])]
          .sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType))
          .map((meal): Written & { mealType: string } => {
            const servings = meal.servings * meal.quantityScale;
            if (meal.source === 'USER_CUSTOM' || !meal.recipe) {
              return {
                mealType: meal.mealType,
                kind: 'meal',
                name: meal.customName ?? '',
                servings,
                estimated: false,
                ...scaledFigures(customMacros(meal.customMacros), servings),
              };
            }
            const recipe = meal.recipe;
            return {
              mealType: meal.mealType,
              kind: 'recipe',
              recipeId: recipe.id,
              name: pickTitle(locale, recipe.translations, recipe.title),
              servings,
              estimated: false,
              ...scaledFigures(perServing(recipe), servings),
            };
          });
        const copies = [
          ...eaten,
          ...entries.map((entry): Written & { mealType: string } => ({
            mealType: entry.mealType,
            kind: entry.kind,
            recipeId: entry.recipeId,
            ingredientId: entry.ingredientId,
            name: entry.name,
            servings: entry.servings,
            quantity: entry.quantity,
            unit: entry.unit,
            estimated: entry.estimated,
            calories: entry.calories,
            protein: entry.protein,
            fat: entry.fat,
            carbs: entry.carbs,
          })),
        ];
        // The copies keep their order: the first of them is the first written.
        const now = Date.now();
        const copied = await this.prisma.$transaction(async (tx) => {
          await this.makeRoom(tx, profileId, to, copies.length);
          if (copies.length > 0) {
            await tx.diaryEntry.createMany({
              data: copies.map((copy, index) => ({
                ...copy,
                profileId,
                date: new Date(to),
                createdAt: new Date(now + index),
              })),
            });
          }
          // What the key keeps is how many entries the copy wrote: the day itself is read again as it is.
          await keep(tx, String(copies.length));
          return copies.length;
        });
        return { copied, day: await this.day(userId, locale, profileId, to) };
      },
      replay: async (kept) => ({
        copied: Number(kept),
        day: await this.day(userId, locale, profileId, to),
      }),
    });
  }

  /** The profile, when it is this user's; otherwise the 404 every route that names a profile gives. */
  private async profile(userId: string, profileId: string): Promise<DiaryProfile> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: PROFILE,
    });
    if (!profile || profile.userId !== userId)
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    return profile;
  }

  /** An entry of one of the user's profiles, as it is now. */
  private async entry(userId: string, locale: Locale, id: string): Promise<DiaryEntry> {
    const row = await this.prisma.diaryEntry.findFirst({
      where: { id, profile: { userId } },
      include: entryWith(locale),
    });
    if (!row) throw entryNotFound();
    return this.toDto(row, locale);
  }

  /** A day of the diary takes no entry before it has come. */
  private refuseDayAhead(date: string, today: string | null): void {
    // Dates in this form compare as text.
    if (date > (today ?? isoDate(new Date()))) {
      throw new ConflictException({
        error: 'DIARY_DAY_AHEAD',
        message: 'The diary takes today and the days before it, not a day still to come.',
      });
    }
  }

  /** Hold the profile and refuse what would put more than the most on the day; the entries are then written in the same transaction. */
  private async makeRoom(
    tx: Prisma.TransactionClient,
    profileId: string,
    date: string,
    adding: number,
  ): Promise<void> {
    await holdProfile(tx, profileId);
    const held = await tx.diaryEntry.count({ where: { profileId, date: new Date(date) } });
    if (held + adding > MAX_DIARY_ENTRIES_A_DAY) {
      throw new ConflictException({
        error: 'DIARY_DAY_FULL',
        message: `A day of the diary holds at most ${MAX_DIARY_ENTRIES_A_DAY} entries.`,
      });
    }
  }

  /**
   * What the day's target is, and the split an estimate goes by: those of
   * the plan's day where a plan holds the day, the profile's own otherwise.
   */
  private aimOf(
    profile: DiaryProfile,
    planDay: {
      calorieTarget: number;
      plan: { dietType: DiaryProfile['dietType']; macroSplit: unknown };
    } | null,
  ): { target: DiaryDay['target']; split: Macros } {
    if (planDay) {
      const own = sharesOf(storedSplit(planDay.plan.macroSplit));
      return {
        target: {
          calories: planDay.calorieTarget,
          ...macrosForCalories(planDay.calorieTarget, planDay.plan.dietType, own),
          from: 'plan',
        },
        split: macroSplitOf(planDay.plan.dietType, own),
      };
    }
    const input = calorieInputOf(profile);
    const calculation = calculateCalories(input);
    return {
      target: { calories: calculation.dailyTarget, ...calculation.targetMacros, from: 'profile' },
      split: macroSplitOf(input.dietType, input.customMacroSplit),
    };
  }

  /** What an entry asked for holds, worked out now from what it is of. */
  private async written(
    userId: string,
    locale: Locale,
    profile: DiaryProfile,
    req: CreateDiaryEntryRequest,
  ): Promise<Written> {
    if (req.kind === 'recipe') {
      // A recipe of the library, or one of the account's own, as the recipe's page finds it.
      const recipe = await this.prisma.recipe.findFirst({
        where: {
          id: req.recipeId,
          deletedAt: null,
          OR: [{ createdByUserId: null }, { createdByUserId: userId }],
        },
        select: {
          title: true,
          caloriesPerServing: true,
          proteinPerServing: true,
          fatPerServing: true,
          carbsPerServing: true,
          translations: {
            where: { locale: { in: languages(locale) } },
            select: { locale: true, title: true },
          },
        },
      });
      if (!recipe)
        throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
      return {
        kind: 'recipe',
        recipeId: req.recipeId,
        name: pickTitle(locale, recipe.translations, recipe.title),
        servings: req.servings,
        estimated: false,
        ...scaledFigures(perServing(recipe), req.servings),
      };
    }

    if (req.kind === 'ingredient') {
      const ingredient = await this.prisma.ingredient.findFirst({
        where: { id: req.ingredientId, retiredAt: null },
        select: {
          name: true,
          canonicalUnit: true,
          gramsPerPiece: true,
          density: true,
          caloriesPer100: true,
          proteinPer100: true,
          fatPer100: true,
          carbsPer100: true,
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
        canonical = toCanonical(req.amount.quantity, req.amount.unit, ingredient);
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
        throw new BadRequestException({
          error: 'DIARY_UNIT_NOT_CONVERTIBLE',
          message: `This ingredient cannot be given in ${req.amount.unit}: use one of the units it is offered in.`,
        });
      }
      return {
        kind: 'ingredient',
        ingredientId: req.ingredientId,
        name: pickIngredient(locale, ingredient.translations, ingredient.name),
        quantity: req.amount.quantity,
        unit: req.amount.unit,
        estimated: false,
        ...nutritionFor(canonical, {
          calories: ingredient.caloriesPer100,
          protein: ingredient.proteinPer100,
          fat: ingredient.fatPer100,
          carbs: ingredient.carbsPer100,
        }),
      };
    }

    const { calories, ...known } = req.nutrition;
    const planDay = await this.prisma.mealPlanDay.findFirst({
      where: { date: new Date(req.date), plan: { profileId: profile.id } },
      orderBy: [...MADE_LAST],
      select: { calorieTarget: true, plan: { select: { dietType: true, macroSplit: true } } },
    });
    const macros = estimatedMacros(calories, known, this.aimOf(profile, planDay).split);
    if (!macros) {
      throw new BadRequestException({
        error: 'DIARY_MACROS_OVER_ENERGY',
        message:
          'The protein, fat and carbohydrate given hold more energy than the calories given.',
      });
    }
    return {
      kind: 'meal',
      name: req.name,
      servings: req.servings,
      estimated:
        known.protein === undefined || known.fat === undefined || known.carbs === undefined,
      ...scaledFigures({ calories, ...macros }, req.servings),
    };
  }

  private toDto(row: EntryRow, locale: Locale): DiaryEntry {
    // A recipe its owner deleted is gone for the diary, as it is for the library.
    const recipe = row.recipe?.deletedAt === null ? row.recipe : null;
    const name = recipe
      ? pickTitle(locale, recipe.translations, recipe.title)
      : row.ingredient
        ? pickIngredient(locale, row.ingredient.translations, row.ingredient.name)
        : row.name;
    return {
      id: row.id,
      profileId: row.profileId,
      date: isoDate(row.date),
      mealType: row.mealType as MealType,
      kind: row.kind,
      name,
      recipeId: recipe ? row.recipeId : null,
      ingredientId: row.ingredientId,
      servings: row.servings,
      amount:
        row.quantity !== null && row.unit !== null
          ? {
              quantity: row.quantity,
              unit: row.unit,
              // An ingredient that is gone is shown in the unit it was given in.
              shown: displayAmount(
                row.quantity,
                row.unit,
                row.ingredient ?? {
                  canonicalUnit: row.unit,
                  gramsPerPiece: null,
                  density: null,
                  displayUnit: null,
                },
              ),
            }
          : null,
      nutrition: wholeFigures(row),
      estimated: row.estimated,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** One serving of a recipe, as the engine worked it out when the recipe was saved. */
function perServing(recipe: {
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
}): Figures {
  return {
    calories: recipe.caloriesPerServing,
    protein: recipe.proteinPerServing,
    fat: recipe.fatPerServing,
    carbs: recipe.carbsPerServing,
  };
}

function entryNotFound(): NotFoundException {
  return new NotFoundException({
    error: 'DIARY_ENTRY_NOT_FOUND',
    message: 'Diary entry not found.',
  });
}

/** A change the entry it is for does not take, refused as a field of the request is. */
function refused(path: string, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'VALIDATION_FAILED',
    message: 'Request payload failed validation.',
    issues: [{ path, message, code: 'custom' }],
  });
}
