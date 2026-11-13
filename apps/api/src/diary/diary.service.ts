// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DIARY_DAYS_BACK,
  DIARY_QUANTITY_LIMITS,
  MAX_DIARY_ENTRIES_A_DAY,
  dayAfter,
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
import { labelLimitsOf } from '../common/label-limits.js';
import { storedSplit } from '../common/stored-split.js';
import {
  fromStoredLabel,
  labelNotes,
  labelOfAmount,
  roundLabel,
  scaleLabel,
  storedTotals,
  sumLabels,
  toStoredLabel,
  UNKNOWN_LABEL,
  type StoredLabel,
} from '../engine/label-totals.js';
import {
  calculateCalories,
  displayAmount,
  estimatedMacros,
  labelEntryFigures,
  macroSplitOf,
  nutritionFor,
  scaledFigures,
  sharesOf,
  toCanonical,
  UnitConversionError,
} from '../engine/index.js';
import { mealRank } from '../meal-plans/meal-plans.service.js';
import {
  aimOfDay as aimOfPlanDay,
  customMacros,
  isoDate,
  isSkipped,
  MADE_LAST,
  mealLabel,
  mealNutrition,
  standingOf,
  sumNutrition,
} from '../meal-plans/plan-days.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  toppingFiguresOf,
  toppingFoodsOf,
  type ToppingFoods,
} from '../meal-plans/toppings-store.js';
import { calorieInputOf } from '../profiles/calorie-input.js';
import { pickIngredient, pickTitle } from '../recipes/recipes.service.js';
import { wholeFigures } from './diary-days.js';
import { entryDto, entryWith, languages } from './diary-entries.js';

/** Energy and the three macronutrients, in kcal and grams. */
type Figures = Macros & { calories: number };

/** A day of a profile's diary in figures: what it ate, what the day aimed at, and whether anything was written. */
export interface DayFigures {
  date: string;
  eaten: Figures;
  target: Figures;
  counted: boolean;
}

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
  expenditureCorrectionKcal: true,
  preferences: {
    select: {
      saltAtMost: true,
      fiberAtLeast: true,
      saturatedFatAtMost: true,
      sugarsAtMost: true,
    },
  },
} as const;
type DiaryProfile = Prisma.ProfileGetPayload<{ select: typeof PROFILE }>;

/** What an entry holds besides where it is: what it is of, its name, its amount and its figures. */
type Written = Pick<
  Prisma.DiaryEntryUncheckedCreateInput,
  | 'kind'
  | 'recipeId'
  | 'ingredientId'
  | 'productId'
  | 'ownProductId'
  | 'productSource'
  | 'name'
  | 'servings'
  | 'quantity'
  | 'unit'
  | 'estimated'
  | 'fiber'
  | 'sugars'
  | 'salt'
  | 'saturatedFat'
  | 'labelAtLeast'
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
          plan: {
            select: { dietType: true, macroSplit: true, calorieTarget: true },
          },
          meals: {
            select: {
              id: true,
              mealType: true,
              servings: true,
              quantityScale: true,
              source: true,
              customName: true,
              customMacros: true,
              rests: true,
              plate: true,
              eatenAt: true,
              toppingKey: true,
              toppingAmount: true,
              // Shared and cooked in one pot: the portion is a split's, near what the plan says.
              shared: { select: { apart: true } },
              recipe: {
                select: {
                  id: true,
                  title: true,
                  caloriesPerServing: true,
                  proteinPerServing: true,
                  fatPerServing: true,
                  carbsPerServing: true,
                  labelPerServing: true,
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
    // The foods of the toppings, read only for a day that has any.
    const toppingFoods = planDay?.meals.some((meal) => meal.toppingKey !== null)
      ? await toppingFoodsOf(this.prisma)
      : (new Map() as ToppingFoods);
    const meals: DiaryPlanMeal[] = [...(planDay?.meals ?? [])]
      .sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType))
      .map((meal) => {
        // A topping is eaten with its meal.
        const topping = toppingFiguresOf(meal, toppingFoods);
        const food = meal.toppingKey !== null ? toppingFoods.get(meal.toppingKey) : undefined;
        return {
          id: meal.id,
          mealType: meal.mealType as MealType,
          name:
            meal.source === 'USER_CUSTOM' || !meal.recipe
              ? (meal.customName ?? '')
              : pickTitle(locale, meal.recipe.translations, meal.recipe.title),
          recipeId: meal.source === 'USER_CUSTOM' ? null : (meal.recipe?.id ?? null),
          eaten: meal.eatenAt !== null,
          nutrition: topping
            ? sumNutrition([mealNutrition(meal), topping.nutrition])
            : mealNutrition(meal),
          label: topping
            ? roundLabel(sumLabels([mealLabel(meal), topping.label]))
            : mealLabel(meal),
          topping:
            topping && food
              ? {
                  name: pickIngredient(locale, food.translations, food.name),
                  display: displayAmount(meal.toppingAmount!, food.canonicalUnit, food),
                }
              : null,
          fromPot: meal.shared !== null && !meal.shared.apart,
        };
      });
    const skipped = planDay ? isSkipped(planDay) : false;
    const eatenLabel = roundLabel(
      sumLabels([
        ...meals.filter((meal) => meal.eaten).map((meal) => meal.label),
        ...rows.map(fromStoredLabel),
      ]),
    );
    // Where the plan's day stands is where its view says it stands: its meals, and the entries as eaten.
    const planned = sumNutrition([...meals.map((meal) => meal.nutrition), ...entered]);
    return {
      profileId,
      date,
      target: this.aimOf(profile, skipped ? null : planDay).target,
      plan: planDay
        ? {
            id: planDay.planId,
            skipped,
            meals,
            ...standingOf(planned.calories, planDay.calorieTarget, skipped),
          }
        : null,
      entries: rows.map((row) => entryDto(row, locale)),
      eaten: sumNutrition([
        ...meals.filter((meal) => meal.eaten).map((meal) => meal.nutrition),
        ...entered,
      ]),
      eatenLabel,
      labelNotes: labelNotes(eatenLabel, labelLimitsOf(profile.preferences)),
      estimated: rows.some((row) => row.estimated),
    };
  }

  /**
   * What a profile ate on each day from `from` to `to`, both included, and
   * what each day aimed at, as the day's own view works them out: the meals
   * of the plan made last that were marked eaten and the entries, against the
   * plan's day or, where no plan holds it or the plan skips it, the profile.
   * A day counts once it holds an entry or a meal marked eaten. For the week
   * in sum and the expenditure worked out from the diary.
   */
  async figuresOfDays(
    userId: string,
    profileId: string,
    from: string,
    to: string,
  ): Promise<DayFigures[]> {
    const profile = await this.profile(userId, profileId);
    const range = { gte: new Date(from), lte: new Date(to) };
    const [planDays, sums] = await Promise.all([
      this.prisma.mealPlanDay.findMany({
        where: { date: range, plan: { profileId } },
        orderBy: [{ date: 'asc' }, ...MADE_LAST],
        select: {
          date: true,
          calorieTarget: true,
          overrides: true,
          plan: {
            select: { dietType: true, macroSplit: true, calorieTarget: true },
          },
          meals: {
            where: { eatenAt: { not: null } },
            select: {
              servings: true,
              quantityScale: true,
              source: true,
              customMacros: true,
              rests: true,
              plate: true,
              toppingKey: true,
              toppingAmount: true,
              recipe: {
                select: {
                  caloriesPerServing: true,
                  proteinPerServing: true,
                  fatPerServing: true,
                  carbsPerServing: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.diaryEntry.groupBy({
        by: ['date'],
        where: { profileId, date: range },
        _sum: { calories: true, protein: true, fat: true, carbs: true },
        _count: true,
      }),
    ]);
    // Of the plans that hold a day, the one made last, as the day's own view picks it.
    const planOf = new Map<string, (typeof planDays)[number]>();
    for (const day of planDays)
      if (!planOf.has(isoDate(day.date))) planOf.set(isoDate(day.date), day);
    const entriesOf = new Map(sums.map((row) => [isoDate(row.date), row]));
    // The foods of the toppings eaten, read only where any was.
    const toppingFoods = [...planOf.values()].some((day) =>
      day.meals.some((meal) => meal.toppingKey !== null),
    )
      ? await toppingFoodsOf(this.prisma)
      : (new Map() as ToppingFoods);
    const days: DayFigures[] = [];
    for (let date = from; date <= to; date = dayAfter(date, 1)) {
      const planDay = planOf.get(date) ?? null;
      const entries = entriesOf.get(date);
      const meals = sumNutrition(
        (planDay?.meals ?? []).flatMap((meal) => {
          const topping = toppingFiguresOf(meal, toppingFoods);
          return topping ? [mealNutrition(meal), topping.nutrition] : [mealNutrition(meal)];
        }),
      );
      const aim = this.aimOf(profile, planDay && !isSkipped(planDay) ? planDay : null).target;
      const target = {
        calories: aim.calories,
        protein: aim.protein,
        fat: aim.fat,
        carbs: aim.carbs,
      };
      days.push({
        date,
        eaten: wholeFigures({
          calories: meals.calories + (entries?._sum.calories ?? 0),
          protein: meals.protein + (entries?._sum.protein ?? 0),
          fat: meals.fat + (entries?._sum.fat ?? 0),
          carbs: meals.carbs + (entries?._sum.carbs ?? 0),
        }),
        target,
        counted: (entries?._count ?? 0) > 0 || (planDay?.meals.length ?? 0) > 0,
      });
    }
    return days;
  }

  /**
   * Write an entry for a day of today or at most `DIARY_DAYS_BACK` days before
   * it (`today` is the client's day). A day holds at most
   * `MAX_DIARY_ENTRIES_A_DAY`, counted while the profile is held. Sent again
   * with its key, the request is answered with the entry the first one wrote,
   * and writes nothing.
   */
  create(
    userId: string,
    locale: Locale,
    req: CreateDiaryEntryRequest,
    key: string | null,
    today: string | null,
  ): Promise<DiaryEntry> {
    this.refuseDayOutside(req.date, today);
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
   * out from when it was written still holds. An entry of a product can be
   * moved to a product of the reader's own, whose label then gives its figures.
   */
  async update(
    userId: string,
    locale: Locale,
    id: string,
    change: UpdateDiaryEntryRequest,
  ): Promise<DiaryEntry> {
    const row = await this.prisma.diaryEntry.findFirst({
      where: { id, profile: { userId } },
    });
    if (!row) throw entryNotFound();
    if (change.productId !== undefined) return this.toOwnProduct(userId, locale, row, change);
    const inAmount = row.kind === 'ingredient' || row.kind === 'product';
    if (change.servings !== undefined && inAmount)
      throw refused(
        'servings',
        'An entry of an ingredient or a product takes a quantity, not servings.',
      );
    if (change.quantity !== undefined && !inAmount)
      throw refused('quantity', 'Only an entry of an ingredient or a product takes a quantity.');
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
        ...scaledLabel(row, factor),
      },
    });
    if (changed.count === 0) throw entryNotFound();
    return this.entry(userId, locale, id);
  }

  /**
   * An entry of a product goes on to a product of the reader's own, as when its
   * reader corrects what the base says: the same amount, or the one the change
   * gives, with the figures of that product's label.
   */
  private async toOwnProduct(
    userId: string,
    locale: Locale,
    row: {
      id: string;
      profileId: string;
      date: Date;
      kind: string;
      quantity: number | null;
    },
    change: UpdateDiaryEntryRequest,
  ): Promise<DiaryEntry> {
    if (row.kind !== 'product')
      throw refused('productId', 'Only an entry of a product takes another product.');
    if (change.servings !== undefined)
      throw refused('servings', 'An entry of a product takes a quantity, not servings.');
    const own = await this.prisma.ownProduct.findFirst({
      where: { id: change.productId, userId },
    });
    if (!own) {
      throw new NotFoundException({
        error: 'PRODUCT_NOT_FOUND',
        message: 'No product with this code is known.',
      });
    }
    const quantity = change.quantity ?? row.quantity!;
    if (quantity > DIARY_QUANTITY_LIMITS[own.unit])
      throw refused('quantity', `More than a day holds of one food in ${own.unit}.`);
    const profile = await this.profile(userId, row.profileId);
    const figures = labelEntryFigures(
      { ...own, energyWorkedOut: false },
      quantity,
      (await this.aimOfDay(profile, isoDate(row.date))).split,
    );
    // A product of one's own always has its energy; the base's would have been refused when it was written.
    if (!figures) throw entryNotFound();
    const changed = await this.prisma.diaryEntry.updateMany({
      where: { id: row.id, profile: { userId } },
      data: {
        mealType: change.mealType,
        productId: null,
        ownProductId: own.id,
        productSource: 'own',
        name: own.brand ? `${own.name}, ${own.brand}` : own.name,
        quantity,
        unit: own.unit,
        ...figures,
      },
    });
    if (changed.count === 0) throw entryNotFound();
    return this.entry(userId, locale, row.id);
  }

  async remove(userId: string, id: string): Promise<void> {
    // An entry of somebody else's profile is answered as one that is not there.
    const removed = await this.prisma.diaryEntry.deleteMany({
      where: { id, profile: { userId } },
    });
    if (removed.count === 0) throw entryNotFound();
  }

  /**
   * Copy what was eaten on one day into another of today or at most
   * `DIARY_DAYS_BACK` days before it: the entries of `from`, and the meals its
   * plan marked as eaten, which come in as entries with their figures as they
   * are now. Nothing is copied when the day it goes to would hold more than
   * the most. Sent again with its key, the request is answered with the day as
   * it is now, and copies nothing.
   */
  copy(
    userId: string,
    locale: Locale,
    req: CopyDiaryDayRequest,
    key: string | null,
    today: string | null,
  ): Promise<DiaryCopyResult> {
    this.refuseDayOutside(req.to, today);
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
                  rests: true,
                  plate: true,
                  recipe: {
                    select: {
                      id: true,
                      title: true,
                      caloriesPerServing: true,
                      proteinPerServing: true,
                      fatPerServing: true,
                      carbsPerServing: true,
                      labelPerServing: true,
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
              ...recipeLabel(recipe.labelPerServing, servings),
            };
          });
        const copies = [
          ...eaten,
          ...entries.map((entry): Written & { mealType: string } => ({
            mealType: entry.mealType,
            kind: entry.kind,
            recipeId: entry.recipeId,
            ingredientId: entry.ingredientId,
            productId: entry.productId,
            ownProductId: entry.ownProductId,
            productSource: entry.productSource,
            name: entry.name,
            servings: entry.servings,
            quantity: entry.quantity,
            unit: entry.unit,
            estimated: entry.estimated,
            calories: entry.calories,
            protein: entry.protein,
            fat: entry.fat,
            carbs: entry.carbs,
            fiber: entry.fiber,
            sugars: entry.sugars,
            salt: entry.salt,
            saturatedFat: entry.saturatedFat,
            labelAtLeast: entry.labelAtLeast,
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
      throw new NotFoundException({
        error: 'PROFILE_NOT_FOUND',
        message: 'Profile not found.',
      });
    return profile;
  }

  /** An entry of one of the user's profiles, as it is now. */
  private async entry(userId: string, locale: Locale, id: string): Promise<DiaryEntry> {
    const row = await this.prisma.diaryEntry.findFirst({
      where: { id, profile: { userId } },
      include: entryWith(locale),
    });
    if (!row) throw entryNotFound();
    return entryDto(row, locale);
  }

  /**
   * A day of the diary takes no entry before it has come, nor once it is more
   * than `DIARY_DAYS_BACK` days back: what it holds by then can still be changed.
   */
  private refuseDayOutside(date: string, today: string | null): void {
    const now = today ?? isoDate(new Date());
    // Dates in this form compare as text.
    if (date > now) {
      throw new ConflictException({
        error: 'DIARY_DAY_AHEAD',
        message: 'The diary takes today and the year before it, not a day still to come.',
      });
    }
    if (date < dayAfter(now, -DIARY_DAYS_BACK)) {
      throw new ConflictException({
        error: 'DIARY_DAY_TOO_OLD',
        message: 'The diary takes a new entry at most a year back.',
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
    const held = await tx.diaryEntry.count({
      where: { profileId, date: new Date(date) },
    });
    if (held + adding > MAX_DIARY_ENTRIES_A_DAY) {
      throw new ConflictException({
        error: 'DIARY_DAY_FULL',
        message: `A day of the diary holds at most ${MAX_DIARY_ENTRIES_A_DAY} entries.`,
      });
    }
  }

  /**
   * What the day's target is, and the split an estimate goes by: those of
   * the plan's day where a plan holds the day and does not skip it, the
   * profile's own otherwise.
   */
  private aimOf(
    profile: DiaryProfile,
    planDay: {
      calorieTarget: number;
      overrides: unknown;
      plan: {
        dietType: DiaryProfile['dietType'];
        macroSplit: unknown;
        calorieTarget: number;
      };
    } | null,
  ): { target: DiaryDay['target']; split: Macros } {
    if (planDay) {
      const own = sharesOf(storedSplit(planDay.plan.macroSplit));
      return {
        target: {
          calories: planDay.calorieTarget,
          ...aimOfPlanDay(planDay, planDay.plan),
          from: 'plan',
        },
        split: macroSplitOf(planDay.plan.dietType, own),
      };
    }
    const input = calorieInputOf(profile);
    const calculation = calculateCalories(input);
    return {
      target: {
        calories: calculation.dailyTarget,
        ...calculation.targetMacros,
        from: 'profile',
      },
      split: macroSplitOf(input.dietType, input.customMacroSplit),
    };
  }

  /** What a day aims at and the split an estimate of it goes by, read from the plan that holds it. */
  private async aimOfDay(
    profile: DiaryProfile,
    date: string,
  ): Promise<ReturnType<DiaryService['aimOf']>> {
    const planDay = await this.prisma.mealPlanDay.findFirst({
      where: { date: new Date(date), plan: { profileId: profile.id } },
      orderBy: [...MADE_LAST],
      select: {
        calorieTarget: true,
        overrides: true,
        plan: {
          select: { dietType: true, macroSplit: true, calorieTarget: true },
        },
      },
    });
    return this.aimOf(profile, planDay && !isSkipped(planDay) ? planDay : null);
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
          labelPerServing: true,
          translations: {
            where: { locale: { in: languages(locale) } },
            select: { locale: true, title: true },
          },
        },
      });
      if (!recipe)
        throw new NotFoundException({
          error: 'RECIPE_NOT_FOUND',
          message: 'Recipe not found.',
        });
      return {
        kind: 'recipe',
        recipeId: req.recipeId,
        name: pickTitle(locale, recipe.translations, recipe.title),
        servings: req.servings,
        estimated: false,
        ...scaledFigures(perServing(recipe), req.servings),
        ...recipeLabel(recipe.labelPerServing, req.servings),
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
        ...toStoredLabel(labelOfAmount(ingredient, canonical)),
      };
    }

    if (req.kind === 'product') {
      const base = await this.prisma.product.findUnique({
        where: { id: req.productId },
      });
      // Not the base's: a product of the account's own, which nobody else's request can reach.
      const own = base
        ? null
        : await this.prisma.ownProduct.findFirst({
            where: { id: req.productId, userId: profile.userId },
          });
      const product = base ?? (own && { ...own, energyWorkedOut: false });
      if (!product) {
        throw new NotFoundException({
          error: 'PRODUCT_NOT_FOUND',
          message: 'No product with this code is known.',
        });
      }
      const figures = labelEntryFigures(
        product,
        req.quantity,
        (await this.aimOfDay(profile, req.date)).split,
      );
      if (!figures) {
        throw new ConflictException({
          error: 'PRODUCT_WITHOUT_FIGURES',
          message: 'The label of this product gives no energy: write it as a meal of your own.',
        });
      }
      return {
        kind: 'product',
        productId: base ? req.productId : null,
        ownProductId: own ? req.productId : null,
        productSource: own ? 'own' : base?.origin === 'accepted' ? 'instance' : 'open_food_facts',
        name: product.brand ? `${product.name}, ${product.brand}` : product.name,
        quantity: req.quantity,
        unit: product.unit,
        ...figures,
      };
    }

    const { calories, ...known } = req.nutrition;
    const aim = await this.aimOfDay(profile, req.date);
    const macros = estimatedMacros(calories, known, aim.split);
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
}

/** What an entry's label says for another amount of it. */
function scaledLabel(
  row: {
    fiber: number | null;
    sugars: number | null;
    salt: number | null;
    saturatedFat: number | null;
  },
  factor: number,
): {
  fiber: number | null;
  sugars: number | null;
  salt: number | null;
  saturatedFat: number | null;
} {
  const scaled = (grams: number | null): number | null => (grams === null ? null : grams * factor);
  return {
    fiber: scaled(row.fiber),
    sugars: scaled(row.sugars),
    salt: scaled(row.salt),
    saturatedFat: scaled(row.saturatedFat),
  };
}

/** What servings of a recipe hold of fibre, sugars, salt and saturated fat, as an entry keeps it. */
function recipeLabel(labelPerServing: unknown, servings: number): StoredLabel {
  return toStoredLabel(scaleLabel(storedTotals(labelPerServing) ?? UNKNOWN_LABEL, servings));
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
