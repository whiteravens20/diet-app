// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for InventoryService (pantry). Prisma + the ingredient DTO
 * mapper are mocked. Focus: ownership guards on every mutation, the upsert
 * aggregation rule (same profile+ingredient+unit adds quantity), and DTO
 * date formatting.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../ingredients/ingredients.service.js', () => ({
  toIngredientDto: (i: { id: string }) => ({ id: i.id, name: 'mock' }),
}));

const { InventoryService } = await import('./inventory.service.js');

const INGREDIENT = { id: 'ing-1', translations: [] };

function makePrisma(owner: string | null = 'user-1', existing: Record<string, unknown> | null = null) {
  return {
    profile: { findUnique: vi.fn().mockResolvedValue(owner === null ? null : { userId: owner }) },
    ingredient: { findUnique: vi.fn().mockResolvedValue({ id: 'ing-1' }) },
    inventoryItem: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'i1', quantity: 200, unit: 'g', bestBefore: null, note: null, createdAt: new Date(), updatedAt: new Date(), ingredient: INGREDIENT },
      ]),
      findUnique: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'i-new', createdAt: new Date(), updatedAt: new Date(), ingredient: INGREDIENT, bestBefore: null, note: null, ...args.data }),
      ),
      update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'i1', unit: 'g', createdAt: new Date(), updatedAt: new Date(), ingredient: INGREDIENT, bestBefore: null, note: null, ...args.data }),
      ),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return new InventoryService(prisma as any);
}

describe('InventoryService ownership', () => {
  it('blocks list/upsert for a foreign profile', async () => {
    const prisma = makePrisma('other');
    await expect(makeService(prisma).list('user-1', 'en', 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      makeService(prisma).upsert('user-1', 'en', 'p1', { ingredientId: 'ing-1', quantity: 1, unit: 'g' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patch/remove throw NOT_FOUND for a missing item', async () => {
    const prisma = makePrisma('user-1');
    prisma.inventoryItem.findUnique = vi.fn().mockResolvedValue(null);
    await expect(makeService(prisma).patch('user-1', 'en', 'missing', {} as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(makeService(prisma).remove('user-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('patch/remove block items owned by another user', async () => {
    const prisma = makePrisma('user-1');
    prisma.inventoryItem.findUnique = vi.fn().mockResolvedValue({ id: 'i1', quantity: 100, profile: { userId: 'other' } });
    await expect(makeService(prisma).remove('user-1', 'i1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.inventoryItem.delete).not.toHaveBeenCalled();
  });
});

describe('InventoryService.upsert aggregation', () => {
  it('creates a new row when none exists for (profile,ingredient,unit)', async () => {
    const prisma = makePrisma('user-1', null);
    await makeService(prisma).upsert('user-1', 'en', 'p1', { ingredientId: 'ing-1', quantity: 150, unit: 'g' } as never);
    expect(prisma.inventoryItem.create).toHaveBeenCalled();
    expect(prisma.inventoryItem.create.mock.calls[0][0].data.quantity).toBe(150);
  });

  it('refuses a new row for an ingredient that does not exist', async () => {
    const prisma = makePrisma('user-1', null);
    prisma.ingredient.findUnique = vi.fn().mockResolvedValue(null);
    await expect(
      makeService(prisma).upsert('user-1', 'en', 'p1', { ingredientId: 'gone', quantity: 150, unit: 'g' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.inventoryItem.create).not.toHaveBeenCalled();
  });

  it('adds to the existing quantity when the row already exists', async () => {
    const prisma = makePrisma('user-1', { id: 'i1', quantity: 200, bestBefore: null, note: null });
    await makeService(prisma).upsert('user-1', 'en', 'p1', { ingredientId: 'ing-1', quantity: 50, unit: 'g' } as never);
    expect(prisma.inventoryItem.update).toHaveBeenCalled();
    expect(prisma.inventoryItem.update.mock.calls[0][0].data.quantity).toBe(250);
  });
});

describe('InventoryService.toDto', () => {
  it('formats bestBefore to a YYYY-MM-DD date string', async () => {
    const prisma = makePrisma('user-1');
    prisma.inventoryItem.findMany = vi.fn().mockResolvedValue([
      { id: 'i1', quantity: 1, unit: 'piece', bestBefore: new Date('2026-08-15T00:00:00.000Z'), note: 'x', createdAt: new Date(), updatedAt: new Date(), ingredient: INGREDIENT },
    ]);
    const [dto] = await makeService(prisma).list('user-1', 'en', 'p1');
    expect(dto.bestBefore).toBe('2026-08-15');
    expect(dto.ingredient).toMatchObject({ id: 'ing-1' });
  });
});
