import { describe, expect, it } from 'vitest';
import { buildCurrentIngredientOverrides } from './current-overrides.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';

type Row = {
  locale: string;
  name: string;
  storageHint: string | null;
  ingredient: { slug: string } | null;
};

/** Minimal Prisma stand-in: only `ingredientTranslation.findMany` is used. */
function fakePrisma(rows: Row[]): PrismaService {
  return {
    ingredientTranslation: {
      findMany: async () => rows,
    },
  } as unknown as PrismaService;
}

describe('buildCurrentIngredientOverrides', () => {
  it('groups MANUAL translations by slug into name/storageHint locale maps', async () => {
    const prisma = fakePrisma([
      { locale: 'en', name: 'Beef tenderloin', storageHint: null, ingredient: { slug: 'beef-tenderloin' } },
      { locale: 'pl', name: 'Polędwica wołowa', storageHint: null, ingredient: { slug: 'beef-tenderloin' } },
      { locale: 'pl', name: 'Szpinak baby', storageHint: 'Lodówka, 5 dni', ingredient: { slug: 'spinach' } },
    ]);
    const file = await buildCurrentIngredientOverrides(prisma);
    expect(file).toEqual({
      'beef-tenderloin': { name: { en: 'Beef tenderloin', pl: 'Polędwica wołowa' } },
      spinach: { name: { pl: 'Szpinak baby' }, storageHint: { pl: 'Lodówka, 5 dni' } },
    });
  });

  it('sorts slugs for stable output', async () => {
    const prisma = fakePrisma([
      { locale: 'pl', name: 'Z', storageHint: null, ingredient: { slug: 'zucchini' } },
      { locale: 'pl', name: 'A', storageHint: null, ingredient: { slug: 'apple' } },
    ]);
    const file = await buildCurrentIngredientOverrides(prisma);
    expect(Object.keys(file)).toEqual(['apple', 'zucchini']);
  });

  it('skips rows with no resolvable slug or empty name', async () => {
    const prisma = fakePrisma([
      { locale: 'pl', name: 'Orphan', storageHint: null, ingredient: null },
      { locale: 'pl', name: '', storageHint: null, ingredient: { slug: 'empty-name' } },
      { locale: 'pl', name: 'Keep', storageHint: null, ingredient: { slug: 'keep' } },
    ]);
    const file = await buildCurrentIngredientOverrides(prisma);
    expect(file).toEqual({ keep: { name: { pl: 'Keep' } } });
  });

  it('returns an empty object when there are no MANUAL rows', async () => {
    const file = await buildCurrentIngredientOverrides(fakePrisma([]));
    expect(file).toEqual({});
  });
});
