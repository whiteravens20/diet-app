// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { SessionsService } from '../auth/sessions.service.js';
import { isoDate } from '../meal-plans/plan-days.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

/** How the file names what it is: a client that reads it back knows by this what to expect in it. */
export const ACCOUNT_EXPORT_FORMAT = 'diet-app/account/1';

/** How many rows of a table are read at a time, and how many plans. */
const PAGE = 200;
const PLANS_AT_A_TIME = 20;

/** A day of the calendar as the API writes days, or nothing. */
const day = (date: Date | null): string | null => (date ? isoDate(date) : null);

/**
 * Everything an account holds, written out as one JSON document: the account
 * as it sees itself, its profiles with what they prefer, and what was logged,
 * kept, marked, planned and listed for them.
 *
 * Nothing that proves who somebody is leaves with it: no password, no token,
 * no secret of a second factor, no key to a provider (only that there is
 * one). An address is the account's own, in clear.
 *
 * An account may hold any number of plans and weights, so the document is
 * written piece by piece: a table is read a page at a time and each row goes
 * out as it is read. The last thing in it is `"complete": true`, which a file
 * that was cut short does not have.
 */
@Injectable()
export class AccountExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
  ) {}

  /** The pieces of the document, in the order they are written. */
  async *pieces(userId: string, now: Date = new Date()): AsyncGenerator<string> {
    const account = await this.users.getMe(userId);
    const [user, secondFactor, providers, profiles] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true, operatorAiApprovedAt: true } }),
      this.prisma.secondFactor.findUnique({ where: { userId }, select: { createdAt: true } }),
      this.prisma.aiProviderConfig.findMany({ where: { userId }, orderBy: { provider: 'asc' } }),
      this.prisma.profile.findMany({ where: { userId }, include: { preferences: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    const profileIds = profiles.map((profile) => profile.id);
    const ofTheAccount = { profileId: { in: profileIds } };

    yield `{${field('format', ACCOUNT_EXPORT_FORMAT)},${field('exportedAt', now.toISOString())}`;
    yield `,${field('account', {
      email: account.email,
      displayName: account.displayName,
      emailVerified: account.emailVerified,
      locale: account.locale,
      theme: account.theme,
      palette: account.palette,
      aiMode: account.aiMode,
      weightUnit: account.weightUnit,
      createdAt: user.createdAt.toISOString(),
      // Whether sign-in takes a second step, and since when. Its secret and its recovery codes stay where they are.
      secondFactorSince: secondFactor?.createdAt.toISOString() ?? null,
      // When the operator approved the account for its AI provider, where it did.
      operatorAiApprovedAt: user.operatorAiApprovedAt?.toISOString() ?? null,
    })}`;
    yield `,${field('sessions', await this.sessions.list(userId))}`;
    yield `,${field(
      'aiProviders',
      providers.map((config) => ({
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        enabled: config.enabled,
        // The key is the account's to keep to itself: the file says that there is one.
        hasKey: config.encryptedKey !== null,
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
      })),
    )}`;
    yield `,${field(
      'profiles',
      profiles.map(({ preferences, userId: _owner, inventoryBiasStreak: _streak, lastWeightReminderAt: _reminded, ...profile }) => ({
        ...profile,
        riskAcknowledgedAt: profile.riskAcknowledgedAt?.toISOString() ?? null,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
        preferences: preferences
          ? {
              favoriteIngredientIds: preferences.favoriteIngredientIds,
              excludedIngredientIds: preferences.excludedIngredientIds,
              dislikedIngredientIds: preferences.dislikedIngredientIds,
              allergens: preferences.allergens,
              preferredCuisines: preferences.preferredCuisines,
              maxConsecutiveDaysSameMeal: preferences.maxConsecutiveDaysSameMeal,
              maxTimesPerWeekSameMeal: preferences.maxTimesPerWeekSameMeal,
              maxWeeklyAmountPerIngredient: preferences.maxWeeklyAmountPerIngredient,
              inventoryBiasResetEvery: preferences.inventoryBiasResetEvery,
            }
          : null,
      })),
    )}`;

    yield* list('weights', (page) => this.prisma.weightEntry.findMany({ where: ofTheAccount, ...page }), (entry) => ({
      profileId: entry.profileId,
      kg: entry.kg,
      recordedAt: entry.recordedAt.toISOString(),
    }));

    yield* list(
      'pantry',
      (page) => this.prisma.inventoryItem.findMany({ where: ofTheAccount, include: { ingredient: { select: { slug: true, name: true } } }, ...page }),
      (row) => ({
        profileId: row.profileId,
        ingredientId: row.ingredientId,
        ingredient: row.ingredient.name,
        ingredientSlug: row.ingredient.slug,
        quantity: row.quantity,
        unit: row.unit,
        bestBefore: day(row.bestBefore),
        updatedAt: row.updatedAt.toISOString(),
      }),
    );

    yield* list(
      'markedRecipes',
      (page) => this.prisma.favorite.findMany({ where: ofTheAccount, include: { recipe: { select: { slug: true, title: true } } }, ...page }),
      (marked) => ({
        profileId: marked.profileId,
        recipeId: marked.recipeId,
        recipe: marked.recipe.title,
        recipeSlug: marked.recipe.slug,
        sentiment: marked.sentiment,
        tags: marked.tags,
        markedAt: marked.createdAt.toISOString(),
      }),
    );

    yield* list('favoriteSets', (page) => this.prisma.favoriteSet.findMany({ where: ofTheAccount, ...page }), (set) => ({
      profileId: set.profileId,
      label: set.label,
      slots: set.slots,
      createdAt: set.createdAt.toISOString(),
      updatedAt: set.updatedAt.toISOString(),
    }));

    // The recipes that are the account's own: the ones it deleted are gone from its library, and are not in the file.
    yield* list(
      'ownRecipes',
      (page) =>
        this.prisma.recipe.findMany({
          where: { createdByUserId: userId, deletedAt: null },
          include: { ingredients: { include: { ingredient: { select: { slug: true, name: true } } } } },
          ...page,
        }),
      (recipe) => ({
        id: recipe.id,
        title: recipe.title,
        description: recipe.description,
        servings: recipe.servings,
        mealTypes: recipe.mealTypes,
        dietTags: recipe.dietTags,
        cuisine: recipe.cuisine,
        allergens: recipe.allergens,
        steps: recipe.steps,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        difficulty: recipe.difficulty,
        origin: recipe.origin,
        modelAssisted: recipe.modelAssisted,
        ingredients: recipe.ingredients.map((line) => ({
          ingredientId: line.ingredientId,
          ingredient: line.ingredient.name,
          ingredientSlug: line.ingredient.slug,
          quantity: line.quantity,
          unit: line.unit,
          note: line.note,
        })),
        createdAt: recipe.createdAt.toISOString(),
        updatedAt: recipe.updatedAt.toISOString(),
      }),
    );

    yield* list(
      'plans',
      (page) =>
        this.prisma.mealPlan.findMany({
          where: ofTheAccount,
          include: {
            days: { orderBy: { date: 'asc' }, include: { meals: { include: { recipe: { select: { slug: true, title: true } } } } } },
            shoppingLists: { orderBy: { createdAt: 'asc' }, include: { items: true } },
          },
          ...page,
        }),
      (plan) => ({
        id: plan.id,
        profileId: plan.profileId,
        startDate: isoDate(plan.startDate),
        durationDays: plan.durationDays,
        dietType: plan.dietType,
        calorieTarget: plan.calorieTarget,
        macroSplit: plan.macroSplit,
        generationMode: plan.generationMode,
        options: plan.options,
        createdAt: plan.createdAt.toISOString(),
        days: plan.days.map((planned) => ({
          date: isoDate(planned.date),
          calorieTarget: planned.calorieTarget,
          overrides: planned.overrides,
          meals: planned.meals.map((meal) => ({
            mealType: meal.mealType,
            recipeId: meal.recipeId,
            recipe: meal.recipe?.title ?? null,
            recipeSlug: meal.recipe?.slug ?? null,
            servings: meal.servings,
            quantityScale: meal.quantityScale,
            // A meal of the account's own has no recipe: its name and the numbers that were typed for it.
            ownName: meal.customName,
            ownNutrition: meal.customMacros,
            eatenAt: meal.eatenAt?.toISOString() ?? null,
          })),
        })),
        shoppingLists: plan.shoppingLists.map((shopping) => ({
          fromDate: isoDate(shopping.fromDate),
          toDate: isoDate(shopping.toDate),
          createdAt: shopping.createdAt.toISOString(),
          items: shopping.items.map((item) => ({
            ingredientId: item.ingredientId,
            name: item.name,
            category: item.category,
            totalQuantity: item.totalQuantity,
            unit: item.unit,
            alreadyHaveQuantity: item.alreadyHaveQuantity,
            purchasedQuantity: item.purchasedQuantity,
            checked: item.checked,
          })),
        })),
      }),
      // A plan brings its days, meals and lists: fewer of them are read at a time.
      PLANS_AT_A_TIME,
    );

    yield* list('notifications', (page) => this.prisma.notification.findMany({ where: ofTheAccount, ...page }), (notice) => ({
      profileId: notice.profileId,
      type: notice.type,
      payload: notice.payload,
      readAt: notice.readAt?.toISOString() ?? null,
      createdAt: notice.createdAt.toISOString(),
    }));

    // What was asked of a model for the account: when, of which provider, and how it ended. What was asked and answered is kept nowhere.
    yield* list('aiCalls', (page) => this.prisma.aiUsageLog.findMany({ where: { userId }, ...page }), (call) => ({
      provider: call.provider,
      model: call.model,
      operation: call.operation,
      mode: call.mode,
      outcome: call.outcome,
      promptTokens: call.promptTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
      at: call.createdAt.toISOString(),
    }));

    yield `,${field('complete', true)}}`;
  }
}

/** A field of a JSON object, written out. */
const field = (name: string, value: unknown): string => `${JSON.stringify(name)}:${JSON.stringify(value)}`;

/** Which rows of a table a query reads: a page of them, after the last row of the page before, in an order that does not change between pages. */
interface Page {
  orderBy: { id: 'asc' };
  take: number;
  cursor?: { id: string };
  skip?: number;
}

/**
 * A field that holds every row of a table, written as the rows are read:
 * `size` at a time, until a page comes back short.
 */
async function* list<Row extends { id: string }>(name: string, read: (page: Page) => Promise<Row[]>, written: (row: Row) => unknown, size: number = PAGE): AsyncGenerator<string> {
  yield `,${JSON.stringify(name)}:[`;
  let after: string | undefined;
  let first = true;
  for (;;) {
    const rows = await read({ orderBy: { id: 'asc' }, take: size, ...(after ? { cursor: { id: after }, skip: 1 } : {}) });
    for (const row of rows) {
      yield `${first ? '' : ','}${JSON.stringify(written(row))}`;
      first = false;
    }
    if (rows.length < size) break;
    after = rows.at(-1)!.id;
  }
  yield ']';
}
