import { Injectable } from '@nestjs/common';
import type { Ingredient } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/** Read access to the curated ingredient database. Static seed data. */
@Injectable()
export class IngredientsService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: string | undefined): Promise<Ingredient[]> {
    const rows = await this.prisma.ingredient.findMany({
      where: query ? { name: { contains: query, mode: 'insensitive' } } : undefined,
      orderBy: { name: 'asc' },
      take: 100,
    });
    return rows.map(toIngredientDto);
  }

  /** Resolve a list of ids back to ingredient records — for displaying the
   *  favourite/avoid lists on the profile page without an N+1 round-trip. */
  async getMany(ids: string[]): Promise<Ingredient[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.ingredient.findMany({
      where: { id: { in: ids } },
      orderBy: { name: 'asc' },
    });
    return rows.map(toIngredientDto);
  }
}

function toIngredientDto(row: {
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
}): Ingredient {
  return {
    id: row.id,
    name: row.name,
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
    storageHint: row.storageHint,
  };
}
