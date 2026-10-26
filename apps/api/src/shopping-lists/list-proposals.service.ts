// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import type {
  ListProposal,
  ListProposals,
  Locale,
  MealType,
  ShoppingListItem,
  WeighRequest,
} from '@diet-app/shared';
import { LIST_PROPOSALS } from '../ai/operations.js';
import { WeighService } from '../ai/weigh.service.js';
import {
  convertUnit,
  leftBeyondAccepted,
  leftOf,
  packsFor,
  UnitConversionError,
} from '../engine/index.js';
import { IngredientSwapService } from '../meal-plans/ingredient-swap.service.js';
import { LANGUAGE } from '../meal-plans/swap-shared.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShoppingListsService } from './shopping-lists.service.js';

/** How many proposals are made of a list at most. */
const MOST_PROPOSALS = 8;
/** A substitution in more meals than this is no small thing to do for the sake of a list: it is not proposed. */
const MOST_MEALS_OF_A_MERGE = 2;

type Merge = Extract<ListProposal, { kind: 'merge' }>;
type Leftover = Extract<ListProposal, { kind: 'leftover' }>;

/**
 * What a shopping list could do without. The engine works it out from the
 * list, the plan and the catalogue's substitution rules; a model, when
 * asked, puts the proposals in order and says a sentence of each. Nothing is
 * written here: a merge is made in the plan, as any substitution is.
 */
@Injectable()
export class ListProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lists: ShoppingListsService,
    private readonly swaps: IngredientSwapService,
    private readonly weigher: WeighService,
  ) {}

  async propose(
    userId: string,
    locale: Locale,
    listId: string,
    req: WeighRequest,
  ): Promise<ListProposals> {
    // The list as its owner reads it: this is also what says whose it is.
    const list = await this.lists.get(userId, locale, listId);
    // A row that is ticked is bought: there is nothing left to propose about it.
    const rows = list.groups
      .flatMap((group) => group.items)
      .filter((row) => !row.checked && row.toBuyQuantity > 0);
    const rowOf = new Map(rows.map((row) => [row.ingredientId, row]));
    const ingredients = new Map(
      (
        await this.prisma.ingredient.findMany({
          where: { id: { in: [...rowOf.keys()] } },
          select: {
            id: true,
            canonicalUnit: true,
            gramsPerPiece: true,
            density: true,
            packSize: true,
            perishable: true,
          },
        })
      ).map((ingredient) => [ingredient.id, ingredient]),
    );
    /** What is left to buy of a row, in its ingredient's own unit; null where the row's unit cannot be brought to it. */
    const toBuy = (row: ShoppingListItem): number | null => {
      const ingredient = ingredients.get(row.ingredientId);
      if (!ingredient) return null;
      try {
        return convertUnit(row.toBuyQuantity, row.unit, ingredient.canonicalUnit, ingredient);
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
        return null;
      }
    };

    const merges = await this.merges(userId, locale, list, rowOf, ingredients, toBuy);
    const leftovers: Leftover[] = [];
    for (const row of rows) {
      const ingredient = ingredients.get(row.ingredientId);
      const need = toBuy(row);
      if (
        !ingredient?.perishable ||
        !ingredient.packSize ||
        need === null ||
        leftBeyondAccepted(need, ingredient.packSize) <= 0
      )
        continue;
      leftovers.push({
        kind: 'leftover',
        ingredientId: row.ingredientId,
        name: row.name,
        unit: ingredient.canonicalUnit,
        left: Math.max(1, Math.round(leftOf(need, ingredient.packSize))),
        packSize: ingredient.packSize,
        reason: null,
      });
    }
    // What saves the most first, then what leaves the most of its pack.
    leftovers.sort(
      (a, b) => b.left / b.packSize - a.left / a.packSize || a.name.localeCompare(b.name),
    );
    let proposals: ListProposal[] = [...merges, ...leftovers].slice(0, MOST_PROPOSALS);
    if (!req.weigh || proposals.length === 0)
      return { planId: list.planId, proposals, aiMeta: null };

    const letter = (index: number): string => String.fromCharCode(97 + index);
    const weighed = await this.weigher.weigh(userId, LIST_PROPOSALS, {
      choice: `A shopping list for the days ${list.fromDate} to ${list.toDate} of a meal plan. Each option is something the list could do without, or something its packs will leave over.`,
      matters: [
        'How much less there is to buy, or to throw away.',
        'How much the meals change by it: say what changes on the plate.',
        'How easy it is to do.',
      ],
      options: proposals.map((proposal, index) => ({
        id: letter(index),
        facts:
          proposal.kind === 'merge'
            ? `use ${proposal.to.name} in place of ${proposal.from.name} in ${proposal.meals.length} meal(s): ${proposal.meals.map((meal) => `"${meal.title}"`).join(', ')} | the list then asks for ${proposal.packsSaved} pack(s) fewer, and ${proposal.from.name} leaves it`
            : `${proposal.name}: the packs to buy leave ${proposal.left} ${proposal.unit} of a pack of ${proposal.packSize} ${proposal.unit}, and an opened pack of it does not keep`,
      })),
      language: LANGUAGE[locale],
    });
    const byLetter = new Map(proposals.map((proposal, index) => [letter(index), proposal]));
    proposals = weighed.order.map((id) => ({
      ...byLetter.get(id)!,
      reason: weighed.said.get(id) ?? null,
    }));
    return { planId: list.planId, proposals, aiMeta: weighed.meta };
  }

  /**
   * Two rows that one ingredient could stand for: the catalogue names the
   * second as a substitute for the first, the plan would take it in every
   * meal of the list's days that uses the first, those are two meals at
   * most, and the list would then ask for fewer packs. One proposal for a row
   * that would go: the one that saves the most.
   */
  private async merges(
    userId: string,
    locale: Locale,
    list: { planId: string; fromDate: string; toDate: string },
    rowOf: ReadonlyMap<string, ShoppingListItem>,
    ingredients: ReadonlyMap<string, { packSize: number | null }>,
    toBuy: (row: ShoppingListItem) => number | null,
  ): Promise<Merge[]> {
    const ids = [...rowOf.keys()];
    const rules = await this.prisma.substitutionRule.findMany({
      where: { fromIngredientId: { in: ids }, toIngredientId: { in: ids } },
      select: { fromIngredientId: true, toIngredientId: true },
      orderBy: [{ fromIngredientId: 'asc' }, { toIngredientId: 'asc' }],
    });
    const best = new Map<string, Merge>();
    for (const rule of rules) {
      const from = rowOf.get(rule.fromIngredientId)!;
      const to = rowOf.get(rule.toIngredientId)!;
      const needOfTo = toBuy(to);
      // A row that is counted on from the pantry in part is not all the list's to drop.
      if (needOfTo === null || from.alreadyHaveQuantity > 0) continue;
      const meals = await this.prisma.plannedMeal.findMany({
        where: {
          day: {
            planId: list.planId,
            date: { gte: new Date(list.fromDate), lte: new Date(list.toDate) },
          },
          recipe: { ingredients: { some: { ingredientId: rule.fromIngredientId } } },
        },
        select: {
          id: true,
          mealType: true,
          eatenAt: true,
          source: true,
          day: { select: { date: true } },
          recipe: {
            select: { title: true, translations: { select: { locale: true, title: true } } },
          },
        },
        orderBy: [{ day: { date: 'asc' } }, { mealType: 'asc' }],
      });
      // A meal that was eaten is a record: where one uses the ingredient, the row cannot go.
      if (
        meals.length === 0 ||
        meals.length > MOST_MEALS_OF_A_MERGE ||
        meals.some((meal) => meal.eatenAt !== null || meal.source === 'USER_CUSTOM' || !meal.recipe)
      )
        continue;
      let coming = 0;
      let taken = true;
      for (const meal of meals) {
        const more = await this.swaps.wouldCome(
          userId,
          list.planId,
          meal.id,
          rule.fromIngredientId,
          rule.toIngredientId,
        );
        if (more === null) {
          taken = false;
          break;
        }
        coming += more;
      }
      if (!taken) continue;
      const packOfTo = ingredients.get(to.ingredientId)?.packSize ?? 0;
      const packsSaved =
        (from.packs?.count ?? 0) +
        (to.packs?.count ?? 0) -
        (packOfTo > 0 ? packsFor(needOfTo + coming, packOfTo) : 0);
      if (packsSaved < 1) continue;
      const known = best.get(from.ingredientId);
      if (known && known.packsSaved >= packsSaved) continue;
      best.set(from.ingredientId, {
        kind: 'merge',
        from: { ingredientId: from.ingredientId, name: from.name },
        to: { ingredientId: to.ingredientId, name: to.name },
        meals: meals.map((meal) => ({
          plannedMealId: meal.id,
          date: meal.day.date.toISOString().slice(0, 10),
          mealType: meal.mealType as MealType,
          title:
            (
              meal.recipe!.translations.find((row) => row.locale === locale) ??
              meal.recipe!.translations.find((row) => row.locale === 'en')
            )?.title ?? meal.recipe!.title,
        })),
        packsSaved,
        reason: null,
      });
    }
    return [...best.values()].sort(
      (a, b) =>
        b.packsSaved - a.packsSaved ||
        a.meals.length - b.meals.length ||
        a.from.name.localeCompare(b.from.name),
    );
  }
}
