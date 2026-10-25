// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for FavoritesService. Prisma + the recipe DTO mapper are mocked.
 * Focus on the per-profile ownership guard and the upsert/remove semantics.
 */
import { NotFoundException } from '@nestjs/common';
import { MAX_FAVORITES_PER_PROFILE } from '@diet-app/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FavoritesService } from './favorites.service.js';

// toRecipeDto is exercised by recipes.service tests; here we only need it not to
// blow up on the mocked recipe shape.
vi.mock('../recipes/recipes.service.js', () => ({
  searchMatch: (q: string) => ({ title: { contains: q } }),
  toRecipeDto: (r: { id: string }) => ({ id: r.id, title: 'mock' }),
}));

function makePrisma(owner: string | null = 'user-1') {
  const prisma = {
    profile: {
      findUnique: vi.fn().mockResolvedValue(owner === null ? null : { userId: owner }),
    },
    favorite: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'f1',
          tags: ['quick'],
          sentiment: 'favorite',
          createdAt: new Date('2026-01-05T10:00:00.000Z'),
          recipe: { id: 'r1' },
        },
      ]),
      // Default: the recipe is not marked yet, and the profile has room for it.
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn().mockResolvedValue({ id: 'f1' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // Default: the recipe is visible (curated or own). Tests override to null
    // to exercise the IDOR guard (favoriting a foreign/private recipe).
    recipe: {
      findFirst: vi.fn().mockResolvedValue({ id: 'r1' }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    // A transaction sees the same tables as the client it was begun on.
    $transaction: vi.fn().mockImplementation((work: (tx: unknown) => unknown) => work(prisma)),
  };
  return prisma;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return new FavoritesService(prisma as any);
}

describe('FavoritesService ownership', () => {
  it('rejects listing another user’s profile', async () => {
    const prisma = makePrisma('other');
    await expect(makeService(prisma).list('user-1', 'en', 'p1')).rejects.toMatchObject({
      response: { error: 'PROFILE_NOT_FOUND' },
    });
  });
  it('rejects add for a missing/foreign profile', async () => {
    const prisma = makePrisma(null);
    await expect(
      makeService(prisma).add('user-1', 'p1', 'r1', [], 'favorite'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // IDOR: favoriting another user's private (or soft-deleted) recipe must be
  // refused, otherwise its full content leaks back through `list`.
  it('rejects add for a recipe the user cannot see', async () => {
    const prisma = makePrisma('user-1');
    prisma.recipe.findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      makeService(prisma).add('user-1', 'p1', 'foreign-recipe', [], 'favorite'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.favorite.upsert).not.toHaveBeenCalled();
  });

  it('scopes the list query to visible recipes (not deleted / own-or-curated)', async () => {
    const prisma = makePrisma('user-1');
    await makeService(prisma).list('user-1', 'en', 'p1');
    const where = prisma.favorite.findMany.mock.calls[0][0].where;
    expect(where.recipe.deletedAt).toBeNull();
    expect(where.recipe.OR).toEqual([{ createdByUserId: null }, { createdByUserId: 'user-1' }]);
  });
});

describe('FavoritesService happy paths', () => {
  let prisma: ReturnType<typeof makePrisma>;
  beforeEach(() => {
    prisma = makePrisma('user-1');
  });

  it('lists favorites mapped to {id,tags,sentiment,markedAt,recipe}', async () => {
    const rows = await makeService(prisma).list('user-1', 'en', 'p1');
    expect(rows[0]).toMatchObject({
      id: 'f1',
      tags: ['quick'],
      sentiment: 'favorite',
      markedAt: '2026-01-05T10:00:00.000Z',
    });
    expect(rows[0].recipe).toMatchObject({ id: 'r1' });
  });

  it('passes how a recipe is marked and a tag into the query', async () => {
    await makeService(prisma).list('user-1', 'en', 'p1', { sentiment: 'often', tag: 'quick' });
    const arg = prisma.favorite.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      profileId: 'p1',
      sentiment: 'often',
      tags: { has: 'quick' },
    });
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

  it('refuses a new mark for a profile that has as many as it may', async () => {
    prisma.favorite.count.mockResolvedValue(MAX_FAVORITES_PER_PROFILE);

    await expect(
      makeService(prisma).add('user-1', 'p1', 'r1', [], 'favorite'),
    ).rejects.toMatchObject({ response: { error: 'FAVORITE_LIMIT_REACHED' } });
    expect(prisma.favorite.upsert).not.toHaveBeenCalled();
  });

  it('still takes another word about a recipe that is marked, for a profile that has as many as it may', async () => {
    prisma.favorite.count.mockResolvedValue(MAX_FAVORITES_PER_PROFILE);
    prisma.favorite.findUnique.mockResolvedValue({ id: 'f1' });

    await makeService(prisma).add('user-1', 'p1', 'r1', [], 'avoid');

    expect(prisma.favorite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { tags: [], sentiment: 'avoid' } }),
    );
  });

  it('removes the mark of a recipe', async () => {
    await expect(makeService(prisma).remove('user-1', 'p1', 'r1')).resolves.toBeUndefined();
    expect(prisma.favorite.deleteMany).toHaveBeenCalledWith({
      where: { profileId: 'p1', recipeId: 'r1' },
    });
  });

  it('says so when there was no mark to remove', async () => {
    prisma.favorite.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(makeService(prisma).remove('user-1', 'p1', 'r1')).rejects.toMatchObject({
      response: { error: 'FAVORITE_NOT_FOUND' },
    });
  });

  it('does not take a failure of the database for a mark that was not there', async () => {
    prisma.favorite.deleteMany = vi.fn().mockRejectedValue(new Error('connection lost'));
    await expect(makeService(prisma).remove('user-1', 'p1', 'r1')).rejects.toThrow(
      'connection lost',
    );
  });
});
