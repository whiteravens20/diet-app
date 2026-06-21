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
  toCanonical,
  UnitConversionError,
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
        // F22: custom meals have no ingredients → no shopping line. `eatenAt` is
        // ignored: the list is generated once at plan start, not retroactively.
        if (meal.source === 'USER_CUSTOM' || !meal.recipe) continue;
        for (const ri of meal.recipe.ingredients) {
          ingredientIds.add(ri.ingredientId);
          lines.push({
            ingredientId: ri.ingredientId,
            quantity: ri.quantity,
            unit: ri.unit,
            recipeServings: meal.recipe.servings,
            // Effective amount folds the F22 rebalancer multiplier into servings.
            plannedServings: meal.servings * meal.quantityScale,
          });
        }
      }
    }

    const ingredients = await this.loadIngredients([...ingredientIds]);
    const groups = aggregateShoppingList(lines, ingredients);

    // F15 pre-fill `alreadyHaveQuantity` from the profile's pantry so the
    // user sees their on-hand stock subtracted from the buy column before
    // they touch the list. Inventory rows in any unit are converted to the
    // aggregated item's unit; rows that can't convert (missing density /
    // gramsPerPiece) are skipped and treated as 0 stock.
    const pantryByItemUnit = await this.pantryCoverageByItemUnit(
      plan.profile.id,
      groups.flatMap((g) => g.items),
      ingredients,
    );

    const itemsToCreate = groups.flatMap((g) =>
      g.items.map((item) => {
        const key = `${item.ingredientId}:${item.unit}`;
        const coverage = pantryByItemUnit.get(key);
        const have = Math.min(coverage?.quantity ?? 0, item.totalQuantity);
        // F15.1 single-field UX: pre-fill `purchasedQuantity` with the
        // pantry-credited amount so the user sees one count to grow as
        // they shop. When pantry fully covers the need, the row arrives
        // already checked off (no shopping required) and the pantry
        // decrement is applied immediately.
        const fullyCovered = have >= item.totalQuantity && have > 0;
        return {
          ingredientId: item.ingredientId,
          name: item.name,
          category: item.category,
          totalQuantity: item.totalQuantity,
          unit: item.unit,
          alreadyHaveQuantity: have,
          purchasedQuantity: have > 0 ? have : null,
          checked: fullyCovered,
          inventoryDelta: fullyCovered ? -have : 0,
          pantryBestBefore: coverage?.bestBefore ?? null,
          estimatedCalories: item.estimatedCalories,
        };
      }),
    );

    const list = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shoppingList.create({
        data: {
          planId: plan.id,
          fromDate: from,
          toDate: to,
          items: { create: itemsToCreate },
        },
        include: { items: true },
      });
      // Pantry decrement for rows that arrived already checked off (full pantry
      // coverage). Same transaction so the inventory view is consistent with
      // the new list the user is about to see.
      for (const it of created.items) {
        if (!it.checked || it.alreadyHaveQuantity <= 0) continue;
        await this.applyPantryDeltaTx(tx, plan.profile.id, it.ingredientId, it.unit, -it.alreadyHaveQuantity);
      }
      return created;
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

  /**
   * Delete a list the user owns. Reverses every row's `inventoryDelta` first so
   * the pantry returns to the state it was in before the list ever changed it
   * — otherwise a freshly-generated list (or a re-generated one) sees no pantry
   * because the previous list still "owns" the consumption.
   */
  async remove(userId: string, listId: string): Promise<void> {
    const list = await this.loadOwned(userId, listId);
    const profileId = list.plan.profile.id;
    await this.prisma.$transaction(async (tx) => {
      for (const item of list.items) {
        if (item.inventoryDelta === 0) continue;
        await this.applyPantryDeltaTx(tx, profileId, item.ingredientId, item.unit, -item.inventoryDelta);
      }
      await tx.shoppingList.delete({ where: { id: listId } });
    });
  }

  async get(userId: string, locale: Locale, listId: string): Promise<ShoppingList> {
    const list = await this.loadOwned(userId, listId);
    return this.toDto(list, await this.translationsFor(list.items.map((i) => i.ingredientId), locale));
  }

  /**
   * Update an item's purchased quantity or checked state. F15.1 single-field
   * model: `purchasedQuantity` is the total obtained (pantry pre-credit +
   * shopping). Checked-state derives from the quantity (purchased >= total →
   * checked) unless the caller explicitly overrides. When checked, the net
   * pantry change is:
   *   delta = max(0, purchasedQuantity - totalQuantity) - alreadyHaveQuantity
   * i.e. over-buy banked as leftover, pre-credited pantry consumed. When
   * unchecked, the target delta is zero. `inventoryDelta` snapshots the
   * last-applied delta so any later edit only applies the difference,
   * idempotent across any number of check / edit / uncheck cycles.
   */
  async updateItem(
    userId: string,
    locale: Locale,
    listId: string,
    itemId: string,
    patch: UpdateShoppingItemRequest,
  ): Promise<ShoppingList> {
    const list = await this.loadOwned(userId, listId);
    const item = list.items.find((i) => i.id === itemId);
    if (!item) {
      throw new NotFoundException({ error: 'ITEM_NOT_FOUND', message: 'Shopping list item not found.' });
    }
    const profileId = list.plan.profile.id;

    const nextPurchased =
      patch.purchasedQuantity !== undefined ? patch.purchasedQuantity : item.purchasedQuantity;
    // Auto-derive `checked` from quantity unless the client explicitly sets it.
    // Typing kupione >= total auto-checks; typing less auto-unchecks. Explicit
    // checkbox click wins so the user can still mark a row done at a partial
    // purchase (e.g. shop ran out and they're done shopping for it).
    const autoChecked = (nextPurchased ?? 0) >= item.totalQuantity;
    const nextChecked =
      patch.checked !== undefined
        ? patch.checked
        : patch.purchasedQuantity !== undefined
        ? autoChecked
        : item.checked;

    // When the user explicitly checks a row without filling kupione, treat it
    // as "I got everything" — default the purchased quantity to total.
    const effectivePurchased = nextChecked ? nextPurchased ?? item.totalQuantity : nextPurchased;
    const overBuy = nextChecked ? Math.max(0, (effectivePurchased ?? 0) - item.totalQuantity) : 0;
    const targetDelta = nextChecked ? overBuy - item.alreadyHaveQuantity : 0;
    const pantryDiff = targetDelta - item.inventoryDelta;

    await this.prisma.$transaction(async (tx) => {
      await tx.shoppingListItem.update({
        where: { id: itemId },
        data: {
          purchasedQuantity: effectivePurchased ?? null,
          checked: nextChecked,
          inventoryDelta: targetDelta,
        },
      });
      if (pantryDiff === 0) return;
      await this.applyPantryDeltaTx(tx, profileId, item.ingredientId, item.unit, pantryDiff);
    });
    return this.get(userId, locale, listId);
  }

  /** Apply a signed delta to a pantry row, creating / deleting as needed. */
  private async applyPantryDelta(
    profileId: string,
    ingredientId: string,
    unit: 'g' | 'ml' | 'piece',
    diff: number,
  ): Promise<void> {
    if (diff === 0) return;
    await this.prisma.$transaction((tx) =>
      this.applyPantryDeltaTx(tx, profileId, ingredientId, unit, diff),
    );
  }

  private async applyPantryDeltaTx(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    profileId: string,
    ingredientId: string,
    unit: 'g' | 'ml' | 'piece',
    diff: number,
  ): Promise<void> {
    if (diff === 0) return;
    const existing = await tx.inventoryItem.findUnique({
      where: {
        profileId_ingredientId_unit: { profileId, ingredientId, unit },
      },
    });
    if (!existing) {
      // No row yet — only worth creating if we're adding stock. A negative
      // diff against empty pantry is silently dropped (the user may have
      // hand-deleted the row; we never push a negative quantity).
      if (diff > 0) {
        await tx.inventoryItem.create({
          data: { profileId, ingredientId, quantity: diff, unit },
        });
      }
      return;
    }
    const next = existing.quantity + diff;
    if (next <= 0) {
      await tx.inventoryItem.delete({ where: { id: existing.id } });
    } else {
      await tx.inventoryItem.update({ where: { id: existing.id }, data: { quantity: next } });
    }
  }

  /**
   * Build a `(ingredientId + unit) → { quantity, bestBefore }` map for
   * shopping-list pre-fill. Aggregates every inventory row for the profile,
   * converting each into the requested item-unit using the engine's unit
   * converter, and tracks the earliest best-before across contributing rows so
   * the UI can surface urgency on the "from pantry" chip. Rows that can't
   * convert (missing density / gramsPerPiece) drop out — better to under-count
   * than to claim stock we can't honour.
   */
  private async pantryCoverageByItemUnit(
    profileId: string,
    items: ReadonlyArray<{ ingredientId: string; unit: 'g' | 'ml' | 'piece' }>,
    ingredients: Map<string, EngineIngredient>,
  ): Promise<Map<string, { quantity: number; bestBefore: Date | null }>> {
    const result = new Map<string, { quantity: number; bestBefore: Date | null }>();
    if (items.length === 0) return result;
    const inventoryRows = await this.prisma.inventoryItem.findMany({
      where: { profileId, ingredientId: { in: [...new Set(items.map((i) => i.ingredientId))] } },
    });
    if (inventoryRows.length === 0) return result;

    // Index inventory by ingredientId so we don't re-walk for every item unit.
    const byIngredient = new Map<
      string,
      Array<{ quantity: number; unit: 'g' | 'ml' | 'piece'; bestBefore: Date | null }>
    >();
    for (const row of inventoryRows) {
      const bucket = byIngredient.get(row.ingredientId) ?? [];
      bucket.push({ quantity: row.quantity, unit: row.unit, bestBefore: row.bestBefore });
      byIngredient.set(row.ingredientId, bucket);
    }

    for (const item of items) {
      const rows = byIngredient.get(item.ingredientId);
      if (!rows) continue;
      const ingredient = ingredients.get(item.ingredientId);
      if (!ingredient) continue;
      let total = 0;
      let earliest: Date | null = null;
      for (const row of rows) {
        let contribution = 0;
        if (row.unit === item.unit) {
          contribution = row.quantity;
        } else {
          try {
            const canonicalQty = toCanonical(row.quantity, row.unit, ingredient);
            contribution = toCanonical(canonicalQty, ingredient.canonicalUnit, {
              canonicalUnit: item.unit,
              gramsPerPiece: ingredient.gramsPerPiece,
              density: ingredient.density,
            });
          } catch (err) {
            if (!(err instanceof UnitConversionError)) throw err;
            continue;
          }
        }
        if (contribution <= 0) continue;
        total += contribution;
        if (row.bestBefore && (!earliest || row.bestBefore < earliest)) {
          earliest = row.bestBefore;
        }
      }
      if (total > 0) result.set(`${item.ingredientId}:${item.unit}`, { quantity: total, bestBefore: earliest });
    }
    return result;
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
        purchasedQuantity: number | null;
        pantryBestBefore: Date | null;
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
        purchasedQuantity: item.purchasedQuantity,
        pantryBestBefore: item.pantryBestBefore
          ? item.pantryBestBefore.toISOString().slice(0, 10)
          : null,
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
