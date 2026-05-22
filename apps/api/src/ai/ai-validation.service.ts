import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { nutritionFor, toCanonical } from '../engine/index.js';

/** A recipe ingredient line as drafted by an AI model. */
export interface DraftIngredientLine {
  ingredientName: string;
  quantity: number;
  unit: 'g' | 'ml' | 'piece';
}

export interface ValidatedRecipe {
  /** Lines that mapped cleanly to curated ingredients. */
  lines: { ingredientId: string; name: string; quantity: number; unit: 'g' | 'ml' | 'piece' }[];
  /** Names the AI invented that have no database match — dropped. */
  rejected: string[];
  /** Names remapped to an approved equivalent. */
  remapped: { from: string; to: string }[];
  /** Nutrition recomputed deterministically from the curated database. */
  nutrition: { calories: number; protein: number; fat: number; carbs: number };
}

/**
 * Enforces the AI safety contract: AI may draft recipe *structure*, but every
 * ingredient must resolve to a curated database record and ALL nutrition is
 * recomputed here. AI numbers are never trusted (product principles #1, #2).
 */
@Injectable()
export class AiValidationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate an AI-drafted ingredient list against the curated database.
   * Unknown ingredients are matched by name (exact, then case-insensitive,
   * then tag/substitution fallback) or rejected.
   */
  async validateIngredients(draft: DraftIngredientLine[]): Promise<ValidatedRecipe> {
    const all = await this.prisma.ingredient.findMany();
    const byLowerName = new Map(all.map((i) => [i.name.toLowerCase(), i]));

    const lines: ValidatedRecipe['lines'] = [];
    const rejected: string[] = [];
    const remapped: { from: string; to: string }[] = [];
    let calories = 0;
    let protein = 0;
    let fat = 0;
    let carbs = 0;

    for (const line of draft) {
      const exact = byLowerName.get(line.ingredientName.toLowerCase());
      const match = exact ?? this.fuzzyMatch(line.ingredientName, all);
      if (!match) {
        rejected.push(line.ingredientName);
        continue;
      }
      if (match.name.toLowerCase() !== line.ingredientName.toLowerCase()) {
        remapped.push({ from: line.ingredientName, to: match.name });
      }
      const canonical = toCanonical(line.quantity, line.unit, match);
      const n = nutritionFor(canonical, {
        calories: match.caloriesPer100,
        protein: match.proteinPer100,
        fat: match.fatPer100,
        carbs: match.carbsPer100,
      });
      calories += n.calories;
      protein += n.protein;
      fat += n.fat;
      carbs += n.carbs;
      lines.push({
        ingredientId: match.id,
        name: match.name,
        quantity: line.quantity,
        unit: line.unit,
      });
    }

    return {
      lines,
      rejected,
      remapped,
      nutrition: {
        calories: Math.round(calories),
        protein: Math.round(protein),
        fat: Math.round(fat),
        carbs: Math.round(carbs),
      },
    };
  }

  /** Loose name match: substring containment in either direction. */
  private fuzzyMatch<T extends { name: string }>(name: string, all: T[]): T | undefined {
    const needle = name.toLowerCase();
    return all.find(
      (i) => i.name.toLowerCase().includes(needle) || needle.includes(i.name.toLowerCase()),
    );
  }
}
