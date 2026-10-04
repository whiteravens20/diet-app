// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for IngredientsService + the shared `toIngredientDto` mapper.
 * Prisma is mocked. Focus: the EN-vs-locale translation `where` clause, the
 * empty-ids short-circuit, and translation fallback (locale → en → canonical).
 */
import { describe, expect, it, vi } from 'vitest';
import { IngredientsService, toIngredientDto } from './ingredients.service.js';

function row(overrides: Record<string, unknown> = {}) {
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
    allergens: [],
    dietCompatibility: [],
    tags: [],
    packSize: null,
    brand: null,
    storageHint: 'Cool, dark place',
    translations: [],
    ...overrides,
  };
}

function makeService(rows = [row()]) {
  const prisma = { ingredient: { findMany: vi.fn().mockResolvedValue(rows) } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return { service: new IngredientsService(prisma as any), prisma };
}

describe('IngredientsService.search', () => {
  it('queries canonical name OR locale translation when a query is given (pl)', async () => {
    const { service, prisma } = makeService();
    await service.search('pl', 'oliwa');
    const where = prisma.ingredient.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeDefined();
    expect(JSON.stringify(where.OR)).toContain('oliwa');
    expect(JSON.stringify(where.OR)).toContain('insensitive');
  });

  it('omits the where filter entirely when no query is given', async () => {
    const { service, prisma } = makeService();
    await service.search('en', undefined);
    expect(prisma.ingredient.findMany.mock.calls[0][0].where).toBeUndefined();
  });
});

describe('IngredientsService.getMany', () => {
  it('short-circuits on an empty id list (no query)', async () => {
    const { service, prisma } = makeService();
    expect(await service.getMany('en', [])).toEqual([]);
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
  });

  it('resolves ids to DTOs', async () => {
    const { service } = makeService([row()]);
    const out = await service.getMany('en', ['ing-1']);
    expect(out[0]).toMatchObject({ id: 'ing-1', name: 'Olive oil' });
  });
});

describe('toIngredientDto translation fallback', () => {
  it('uses the locale translation when present', () => {
    const dto = toIngredientDto(
      row({ translations: [{ locale: 'pl', name: 'Oliwa z oliwek', storageHint: 'Chłodne miejsce' }] }),
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
