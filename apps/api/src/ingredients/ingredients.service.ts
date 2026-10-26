// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Ingredient, Locale } from '@diet-app/shared';
import { collatedFor, containing } from '../common/collation.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Read access to the curated ingredient database. Static seed data. */
@Injectable()
export class IngredientsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The first hundred ingredients whose name holds `query`, by the name they
   * are shown under: the name in the language of the request, or the English
   * one where there is none. A search finds a row by either name, so that a
   * row that has only its English name is found by it in any language.
   */
  async search(locale: Locale, query: string | undefined): Promise<Ingredient[]> {
    const named = query
      ? Prisma.sql`AND (i."name" ILIKE ${containing(query)} OR t."name" ILIKE ${containing(query)})`
      : Prisma.empty;
    const first = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT i."id" FROM "Ingredient" i
      LEFT JOIN "IngredientTranslation" t ON t."ingredientId" = i."id" AND t."locale" = ${locale}
      WHERE i."retiredAt" IS NULL ${named}
      ORDER BY COALESCE(t."name", i."name") ${collatedFor(locale)}, i."id"
      LIMIT 100`;
    return this.inOrder(
      locale,
      first.map((row) => row.id),
    );
  }

  /** Resolve a list of ids back to ingredient records — for displaying the
   *  favourite/avoid lists on the profile page without an N+1 round-trip. */
  async getMany(locale: Locale, ids: string[]): Promise<Ingredient[]> {
    if (ids.length === 0) return [];
    const sorted = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT i."id" FROM "Ingredient" i
      LEFT JOIN "IngredientTranslation" t ON t."ingredientId" = i."id" AND t."locale" = ${locale}
      WHERE i."id" = ANY(${ids}::text[])
      ORDER BY COALESCE(t."name", i."name") ${collatedFor(locale)}, i."id"`;
    return this.inOrder(
      locale,
      sorted.map((row) => row.id),
    );
  }

  /** The ingredients of `ids`, as the request's language shows them, in the order of `ids`. */
  private async inOrder(locale: Locale, ids: string[]): Promise<Ingredient[]> {
    const rows = await this.prisma.ingredient.findMany({
      where: { id: { in: ids } },
      include: translationsInclude(locale),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toIngredientDto(row, locale)] : [];
    });
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
  const match =
    translations.find((t) => t.locale === locale) ?? translations.find((t) => t.locale === 'en');
  return match ?? fallback;
}

export function toIngredientDto(
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
    displayUnit: Ingredient['displayUnit'];
    perTeaspoon: number | null;
    allergens: string[];
    dietCompatibility: string[];
    tags: string[];
    packSize: number | null;
    perishable: boolean;
    brand: string | null;
    storageHint: string | null;
    translations?: { locale: string; name: string; storageHint: string | null }[];
  },
  locale: Locale,
): Ingredient {
  const text = pickTranslated(locale, row.translations, {
    name: row.name,
    storageHint: row.storageHint,
  });
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
    displayUnit: row.displayUnit,
    perTeaspoon: row.perTeaspoon,
    allergens: row.allergens as Ingredient['allergens'],
    dietCompatibility: row.dietCompatibility as Ingredient['dietCompatibility'],
    tags: row.tags,
    packSize: row.packSize,
    perishable: row.perishable,
    brand: row.brand,
    storageHint: text.storageHint,
  };
}
