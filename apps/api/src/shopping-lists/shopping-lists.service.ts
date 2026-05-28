import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  GenerateShoppingListRequest,
  Locale,
  ShoppingList,
  UpdateShoppingItemRequest,
} from '@diet-app/shared';
import {
  aggregateShoppingList,
  toBuyQuantity,
  type EngineIngredient,
  type PlanIngredientLine,
} from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pickIngredient } from '../recipes/recipes.service.js';

/** Builds and maintains consolidated shopping lists from meal plans. */
@Injectable()
export class ShoppingListsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Aggregate every ingredient across the selected plan range into a list. */
  async generate(userId: string, locale: Locale, req: GenerateShoppingListRequest): Promise<ShoppingList> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: req.planId },
      include: {
        profile: true,
        days: {
          orderBy: { date: 'asc' },
          include: { meals: { include: { recipe: { include: { ingredients: true } } } } },
        },
      },
    });
    if (!plan) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }

    const from = req.fromDate ? new Date(req.fromDate) : plan.days[0]?.date ?? plan.startDate;
    const to = req.toDate ? new Date(req.toDate) : plan.days.at(-1)?.date ?? plan.startDate;

    // Collect ingredient lines from every meal within the range.
    const lines: PlanIngredientLine[] = [];
    const ingredientIds = new Set<string>();
    for (const day of plan.days) {
      if (day.date < from || day.date > to) continue;
      for (const meal of day.meals) {
        for (const ri of meal.recipe.ingredients) {
          ingredientIds.add(ri.ingredientId);
          lines.push({
            ingredientId: ri.ingredientId,
            quantity: ri.quantity,
            unit: ri.unit,
            recipeServings: meal.recipe.servings,
            plannedServings: meal.servings,
          });
        }
      }
    }

    const ingredients = await this.loadIngredients([...ingredientIds]);
    const groups = aggregateShoppingList(lines, ingredients);

    const list = await this.prisma.shoppingList.create({
      data: {
        planId: plan.id,
        fromDate: from,
        toDate: to,
        items: {
          create: groups.flatMap((g) =>
            g.items.map((item) => ({
              ingredientId: item.ingredientId,
              name: item.name,
              category: item.category,
              totalQuantity: item.totalQuantity,
              unit: item.unit,
              estimatedCalories: item.estimatedCalories,
            })),
          ),
        },
      },
      include: { items: true },
    });

    return this.toDto(list, await this.translationsFor(list.items.map((i) => i.ingredientId), locale));
  }

  /** Every list belonging to a plan the user owns, newest first. */
  async listForPlan(userId: string, locale: Locale, planId: string): Promise<ShoppingList[]> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true },
    });
    if (!plan) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    const rows = await this.prisma.shoppingList.findMany({
      where: { planId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    const allIds = rows.flatMap((r) => r.items.map((i) => i.ingredientId));
    const trans = await this.translationsFor(allIds, locale);
    return rows.map((r) => this.toDto(r, trans));
  }

  /** Delete a list the user owns. */
  async remove(userId: string, listId: string): Promise<void> {
    await this.loadOwned(userId, listId);
    await this.prisma.shoppingList.delete({ where: { id: listId } });
  }

  async get(userId: string, locale: Locale, listId: string): Promise<ShoppingList> {
    const list = await this.loadOwned(userId, listId);
    return this.toDto(list, await this.translationsFor(list.items.map((i) => i.ingredientId), locale));
  }

  /** Update an item's "already have" amount or its checked state. */
  async updateItem(
    userId: string,
    locale: Locale,
    listId: string,
    itemId: string,
    patch: UpdateShoppingItemRequest,
  ): Promise<ShoppingList> {
    await this.loadOwned(userId, listId);
    await this.prisma.shoppingListItem.update({
      where: { id: itemId },
      data: {
        ...(patch.alreadyHaveQuantity !== undefined
          ? { alreadyHaveQuantity: patch.alreadyHaveQuantity }
          : {}),
        ...(patch.checked !== undefined ? { checked: patch.checked } : {}),
      },
    });
    return this.get(userId, locale, listId);
  }

  private async loadOwned(userId: string, listId: string) {
    const list = await this.prisma.shoppingList.findUnique({
      where: { id: listId },
      include: { items: true, plan: { include: { profile: true } } },
    });
    if (!list) throw new NotFoundException({ error: 'LIST_NOT_FOUND', message: 'Shopping list not found.' });
    if (list.plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'List belongs to another user.' });
    }
    return list;
  }

  /**
   * Load locale-resolved display names for the given ingredient ids. The
   * shopping-list row snapshots the English name at generation time; resolving
   * fresh on every read means switching the user's locale localises old lists
   * too, with no schema migration of historical rows.
   */
  private async translationsFor(
    ingredientIds: string[],
    locale: Locale,
  ): Promise<Map<string, string>> {
    if (ingredientIds.length === 0) return new Map();
    const rows = await this.prisma.ingredient.findMany({
      where: { id: { in: [...new Set(ingredientIds)] } },
      select: { id: true, name: true, translations: { select: { locale: true, name: true } } },
    });
    return new Map(rows.map((r) => [r.id, pickIngredient(locale, r.translations, r.name)]));
  }

  private async loadIngredients(ids: string[]): Promise<Map<string, EngineIngredient>> {
    const rows = await this.prisma.ingredient.findMany({ where: { id: { in: ids } } });
    return new Map(
      rows.map((i) => [
        i.id,
        {
          id: i.id,
          name: i.name,
          category: i.category,
          canonicalUnit: i.canonicalUnit,
          gramsPerPiece: i.gramsPerPiece,
          density: i.density,
          caloriesPer100: i.caloriesPer100,
          proteinPer100: i.proteinPer100,
          fatPer100: i.fatPer100,
          carbsPer100: i.carbsPer100,
          allergens: i.allergens as EngineIngredient['allergens'],
          dietCompatibility: i.dietCompatibility as EngineIngredient['dietCompatibility'],
        },
      ]),
    );
  }

  private toDto(
    list: {
      id: string;
      planId: string;
      fromDate: Date;
      toDate: Date;
      createdAt: Date;
      items: {
        id: string;
        ingredientId: string;
        name: string;
        category: string;
        totalQuantity: number;
        unit: 'g' | 'ml' | 'piece';
        alreadyHaveQuantity: number;
        estimatedCalories: number;
        checked: boolean;
      }[];
    },
    names: Map<string, string>,
  ): ShoppingList {
    const byCategory = new Map<string, ShoppingList['groups'][number]['items']>();
    let totalCalories = 0;

    for (const item of list.items) {
      totalCalories += item.estimatedCalories;
      const entry = {
        id: item.id,
        ingredientId: item.ingredientId,
        // Use the locale-resolved name; fall back to the snapshot stored on
        // the row if the underlying ingredient was deleted (the row keeps the
        // English name as a tombstone so the user still sees something).
        name: names.get(item.ingredientId) ?? item.name,
        category: item.category as ShoppingList['groups'][number]['category'],
        totalQuantity: item.totalQuantity,
        unit: item.unit,
        alreadyHaveQuantity: item.alreadyHaveQuantity,
        toBuyQuantity: toBuyQuantity(item.totalQuantity, item.alreadyHaveQuantity),
        estimatedCalories: item.estimatedCalories,
        checked: item.checked,
      };
      const bucket = byCategory.get(item.category) ?? [];
      bucket.push(entry);
      byCategory.set(item.category, bucket);
    }

    return {
      id: list.id,
      planId: list.planId,
      fromDate: list.fromDate.toISOString().slice(0, 10),
      toDate: list.toDate.toISOString().slice(0, 10),
      groups: [...byCategory.entries()].map(([category, items]) => ({
        category: category as ShoppingList['groups'][number]['category'],
        items: [...items].sort((a, b) => a.name.localeCompare(b.name)),
      })),
      totalEstimatedCalories: Math.round(totalCalories),
      createdAt: list.createdAt.toISOString(),
    };
  }
}
