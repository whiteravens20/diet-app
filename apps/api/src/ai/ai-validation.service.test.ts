// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for AiValidationService — the AI safety contract. AI may draft
 * recipe structure, but every ingredient must resolve to a curated DB record
 * and ALL nutrition is recomputed here (product principles #1/#2). Prisma is
 * mocked with a tiny curated catalogue; the engine math is the real function.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiValidationService } from './ai-validation.service.js';

const CATALOGUE = [
  {
    id: 'ing-chicken',
    name: 'Chicken breast',
    canonicalUnit: 'g',
    gramsPerPiece: null,
    density: null,
    caloriesPer100: 165,
    proteinPer100: 31,
    fatPer100: 3.6,
    carbsPer100: 0,
  },
  {
    id: 'ing-rice',
    name: 'White rice',
    canonicalUnit: 'g',
    gramsPerPiece: null,
    density: null,
    caloriesPer100: 130,
    proteinPer100: 2.7,
    fatPer100: 0.3,
    carbsPer100: 28,
  },
];

function makeService(catalogue = CATALOGUE) {
  const prisma = { ingredient: { findMany: vi.fn().mockResolvedValue(catalogue) } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return new AiValidationService(prisma as any);
}

describe('AiValidationService.validateIngredients', () => {
  it('recomputes nutrition deterministically from the curated DB (AI numbers ignored)', async () => {
    const res = await makeService().validateIngredients([
      { ingredientName: 'Chicken breast', quantity: 200, unit: 'g' },
    ]);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].ingredientId).toBe('ing-chicken');
    // 200 g of 165 kcal/100g = 330 kcal, 62 g protein — computed, not supplied.
    expect(res.nutrition.calories).toBe(330);
    expect(res.nutrition.protein).toBe(62);
  });

  it('rejects an invented ingredient with no catalogue match', async () => {
    const res = await makeService().validateIngredients([
      { ingredientName: 'Unobtanium powder', quantity: 50, unit: 'g' },
    ]);
    expect(res.lines).toHaveLength(0);
    expect(res.rejected).toContain('Unobtanium powder');
    expect(res.nutrition.calories).toBe(0);
  });

  it('records a remap when a fuzzy match differs from the drafted name', async () => {
    const res = await makeService().validateIngredients([
      { ingredientName: 'chicken', quantity: 100, unit: 'g' }, // substring of "Chicken breast"
    ]);
    expect(res.lines[0]?.ingredientId).toBe('ing-chicken');
    expect(res.remapped).toEqual([{ from: 'chicken', to: 'Chicken breast' }]);
  });

  it('matches case-insensitively without a remap when names are equal', async () => {
    const res = await makeService().validateIngredients([
      { ingredientName: 'WHITE RICE', quantity: 100, unit: 'g' },
    ]);
    expect(res.lines[0]?.ingredientId).toBe('ing-rice');
    expect(res.remapped).toEqual([]);
  });

  it('sums nutrition across multiple lines', async () => {
    const res = await makeService().validateIngredients([
      { ingredientName: 'Chicken breast', quantity: 100, unit: 'g' },
      { ingredientName: 'White rice', quantity: 100, unit: 'g' },
    ]);
    expect(res.nutrition.calories).toBe(165 + 130);
  });
});
