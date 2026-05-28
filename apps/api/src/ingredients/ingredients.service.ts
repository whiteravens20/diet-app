import { Injectable } from '@nestjs/common';
import type { Ingredient, Locale } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/** Read access to the curated ingredient database. Static seed data. */
@Injectable()
export class IngredientsService {
  constructor(private readonly prisma: PrismaService) {}

  async search(locale: Locale, query: string | undefined): Promise<Ingredient[]> {
    const contains = query ? { contains: query, mode: 'insensitive' as const } : undefined;
    const rows = await this.prisma.ingredient.findMany({
      // Match against the canonical English `name` OR the translated name
      // for the request locale, so users searching in PL can find rows
      // whose English title is the only canonical source.
      where: contains
        ? { OR: [{ name: contains }, { translations: { some: { locale, name: contains } } }] }
        : undefined,
      include: translationsInclude(locale),
      orderBy: { name: 'asc' },
      take: 100,
    });
    return rows.map((r) => toIngredientDto(r, locale));
  }

  /** Resolve a list of ids back to ingredient records — for displaying the
   *  favourite/avoid lists on the profile page without an N+1 round-trip. */
  async getMany(locale: Locale, ids: string[]): Promise<Ingredient[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.ingredient.findMany({
      where: { id: { in: ids } },
      include: translationsInclude(locale),
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => toIngredientDto(r, locale));
  }
}

function translationsInclude(locale: Locale) {
  const locales = locale === 'en' ? ['en'] : [locale, 'en'];
  return { translations: { where: { locale: { in: locales } } } } as const;
}

function pickTranslated(
  locale: Locale,
  translations: { locale: string; name: string; storageHint: string | null }[] | undefined,
  fallback: { name: string; storageHint: string | null },
): { name: string; storageHint: string | null } {
  if (!translations || translations.length === 0) return fallback;
  const match = translations.find((t) => t.locale === locale) ?? translations.find((t) => t.locale === 'en');
  return match ?? fallback;
}

function toIngredientDto(
  row: {
    id: string;
    name: string;
    category: Ingredient['category'];
    canonicalUnit: Ingredient['canonicalUnit'];
    caloriesPer100: number;
    proteinPer100: number;
    fatPer100: number;
    carbsPer100: number;
    gramsPerPiece: number | null;
    density: number | null;
    allergens: string[];
    dietCompatibility: string[];
    tags: string[];
    packSize: number | null;
    brand: string | null;
    storageHint: string | null;
    translations?: { locale: string; name: string; storageHint: string | null }[];
  },
  locale: Locale,
): Ingredient {
  const text = pickTranslated(locale, row.translations, { name: row.name, storageHint: row.storageHint });
  return {
    id: row.id,
    name: text.name,
    category: row.category,
    canonicalUnit: row.canonicalUnit,
    caloriesPer100: row.caloriesPer100,
    proteinPer100: row.proteinPer100,
    fatPer100: row.fatPer100,
    carbsPer100: row.carbsPer100,
    gramsPerPiece: row.gramsPerPiece,
    density: row.density,
    allergens: row.allergens as Ingredient['allergens'],
    dietCompatibility: row.dietCompatibility as Ingredient['dietCompatibility'],
    tags: row.tags,
    packSize: row.packSize,
    brand: row.brand,
    storageHint: text.storageHint,
  };
}
