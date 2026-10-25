// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for the shared `toIngredientDto` mapper: which name an
 * ingredient is shown under (locale → en → canonical). What the service asks
 * the database is tested against one (`ingredients.int.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { toIngredientDto } from './ingredients.service.js';

type Row = Parameters<typeof toIngredientDto>[0];

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'ing-1',
    name: 'Olive oil',
    category: 'fats_oils',
    canonicalUnit: 'ml',
    caloriesPer100: 884,
    proteinPer100: 0,
    fatPer100: 100,
    carbsPer100: 0,
    gramsPerPiece: null,
    density: 0.91,
    displayUnit: null,
    allergens: [],
    dietCompatibility: [],
    tags: [],
    packSize: null,
    perishable: false,
    brand: null,
    storageHint: 'Cool, dark place',
    translations: [],
    ...overrides,
  };
}

describe('toIngredientDto translation fallback', () => {
  it('uses the locale translation when present', () => {
    const dto = toIngredientDto(
      row({
        translations: [{ locale: 'pl', name: 'Oliwa z oliwek', storageHint: 'Chłodne miejsce' }],
      }),
      'pl',
    );
    expect(dto.name).toBe('Oliwa z oliwek');
    expect(dto.storageHint).toBe('Chłodne miejsce');
  });

  it('falls back to the canonical name when no translation row exists', () => {
    const dto = toIngredientDto(row({ translations: [] }), 'pl');
    expect(dto.name).toBe('Olive oil');
  });

  it('falls back to en when the requested locale is absent', () => {
    const dto = toIngredientDto(
      row({ translations: [{ locale: 'en', name: 'Olive oil', storageHint: 'Cool, dark place' }] }),
      'pl',
    );
    expect(dto.name).toBe('Olive oil');
  });
});
