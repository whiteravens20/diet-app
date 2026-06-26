/**
 * Unit tests for FavoritesService. Prisma + the recipe DTO mapper are mocked.
 * Focus on the per-profile ownership guard and the upsert/remove semantics.
 */
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// toRecipeDto is exercised by recipes.service tests; here we only need it not to
// blow up on the mocked recipe shape.
vi.mock('../recipes/recipes.service.js', () => ({
  searchMatch: (q: string) => ({ title: { contains: q } }),
  toRecipeDto: (r: { id: string }) => ({ id: r.id, title: 'mock' }),
}));

const { FavoritesService } = await import('./favorites.service.js');

function makePrisma(owner: string | null = 'user-1') {
  return {
    profile: {
      findUnique: vi.fn().mockResolvedValue(owner === null ? null : { userId: owner }),
    },
    favorite: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'f1', tags: ['quick'], sentiment: 'favorite', recipe: { id: 'r1' } },
      ]),
      upsert: vi.fn().mockResolvedValue({ id: 'f1' }),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return new FavoritesService(prisma as any);
}

describe('FavoritesService ownership', () => {
  it('rejects listing another user’s profile', async () => {
    const prisma = makePrisma('other');
    await expect(makeService(prisma).list('user-1', 'en', 'p1')).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('rejects add for a missing/foreign profile', async () => {
    const prisma = makePrisma(null);
    await expect(makeService(prisma).add('user-1', 'p1', 'r1', [], 'favorite')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('FavoritesService happy paths', () => {
  let prisma: ReturnType<typeof makePrisma>;
  beforeEach(() => {
    prisma = makePrisma('user-1');
  });

  it('lists favorites mapped to {id,tags,sentiment,recipe}', async () => {
    const rows = await makeService(prisma).list('user-1', 'en', 'p1');
    expect(rows[0]).toMatchObject({ id: 'f1', tags: ['quick'], sentiment: 'favorite' });
    expect(rows[0].recipe).toMatchObject({ id: 'r1' });
  });

  it('passes search + mealType filters into the query', async () => {
    await makeService(prisma).list('user-1', 'en', 'p1', { search: 'soup', mealType: 'dinner' });
    const arg = prisma.favorite.findMany.mock.calls[0][0];
    expect(JSON.stringify(arg.where.recipe.AND)).toContain('soup');
    expect(JSON.stringify(arg.where.recipe.AND)).toContain('dinner');
  });

  it('upserts on add (composite profileId_recipeId key)', async () => {
    await makeService(prisma).add('user-1', 'p1', 'r1', ['quick'], 'often');
    expect(prisma.favorite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profileId_recipeId: { profileId: 'p1', recipeId: 'r1' } },
        create: { profileId: 'p1', recipeId: 'r1', tags: ['quick'], sentiment: 'often' },
        update: { tags: ['quick'], sentiment: 'often' },
      }),
    );
  });

  it('remove swallows a missing-row delete error (idempotent)', async () => {
    prisma.favorite.delete = vi.fn().mockRejectedValue(new Error('no row'));
    await expect(makeService(prisma).remove('user-1', 'p1', 'r1')).resolves.toBeUndefined();
  });
});
