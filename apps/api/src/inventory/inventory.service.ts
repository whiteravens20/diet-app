// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { InventoryItem, Locale, PatchInventoryItem, UpsertInventoryItem } from '@diet-app/shared';
import { convertUnit, displayStock, UnitConversionError } from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toIngredientDto } from '../ingredients/ingredients.service.js';
import { assertWithinCeiling, lockPantry } from './pantry-store.js';

/**
 * Per-profile pantry, as the user keeps it by hand. Mutations are all
 * profile-scoped and authorise against the calling user. Each one holds the
 * pantry lock of its ingredient (see `pantry-store.ts`), so it takes turns
 * with a shopping row being ticked and with another request for the same row.
 *
 * What reads the pantry for planning and shopping does so through
 * `engine/pantry.ts`, not through this service.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, locale: Locale, profileId: string): Promise<InventoryItem[]> {
    await this.assertProfile(userId, profileId);
    const rows = await this.prisma.inventoryItem.findMany({
      where: { profileId },
      include: this.withIngredient(locale),
      orderBy: [{ ingredient: { name: 'asc' } }, { unit: 'asc' }],
    });
    return rows.map((r) => this.toDto(r, locale));
  }

  /**
   * Upsert: posting `(profileId, ingredientId, unit)` that already exists
   * aggregates the quantity; otherwise creates a new row. `bestBefore` and
   * `note` overwrite when supplied so the latest update wins.
   */
  async upsert(userId: string, locale: Locale, profileId: string, body: UpsertInventoryItem): Promise<InventoryItem> {
    await this.assertProfile(userId, profileId);
    const ingredient = await this.prisma.ingredient.findUnique({
      where: { id: body.ingredientId },
      select: { id: true, canonicalUnit: true, gramsPerPiece: true, density: true },
    });
    if (!ingredient) {
      throw new NotFoundException({ error: 'INGREDIENT_NOT_FOUND', message: 'Ingredient not found.' });
    }
    // Stock that cannot be added up with the rest would count as nothing
    // everywhere: no list would see it and no plan would use it.
    try {
      convertUnit(body.quantity, body.unit, ingredient.canonicalUnit, ingredient);
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      throw new BadRequestException({
        error: 'UNIT_NOT_CONVERTIBLE',
        message: `This ingredient cannot be kept in ${body.unit}: use ${ingredient.canonicalUnit}.`,
      });
    }

    const key = { profileId_ingredientId_unit: { profileId, ingredientId: body.ingredientId, unit: body.unit } };
    const saved = await this.prisma.$transaction(async (tx) => {
      await lockPantry(tx, profileId, body.ingredientId);
      const existing = await tx.inventoryItem.findUnique({ where: key });
      assertWithinCeiling((existing?.quantity ?? 0) + body.quantity, body.unit);
      return tx.inventoryItem.upsert({
        where: key,
        create: {
          profileId,
          ingredientId: body.ingredientId,
          quantity: body.quantity,
          unit: body.unit,
          bestBefore: this.parseDate(body.bestBefore),
          note: body.note ?? null,
        },
        update: {
          quantity: { increment: body.quantity },
          ...(body.bestBefore !== undefined ? { bestBefore: this.parseDate(body.bestBefore) } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
        },
        include: this.withIngredient(locale),
      });
    });
    return this.toDto(saved, locale);
  }

  async patch(userId: string, locale: Locale, id: string, body: PatchInventoryItem): Promise<InventoryItem> {
    const row = await this.loadOwned(userId, id);
    if (body.quantity !== undefined) assertWithinCeiling(body.quantity, row.unit);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockPantry(tx, row.profileId, row.ingredientId);
      // A shopping row may have used the last of it since it was read.
      const changed = await tx.inventoryItem.updateMany({
        where: { id: row.id },
        data: {
          ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
          ...(body.bestBefore !== undefined ? { bestBefore: this.parseDate(body.bestBefore) } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
        },
      });
      if (changed.count === 0) throw this.notFound();
      return tx.inventoryItem.findUniqueOrThrow({ where: { id: row.id }, include: this.withIngredient(locale) });
    });
    return this.toDto(updated, locale);
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = await this.loadOwned(userId, id);
    await this.prisma.$transaction(async (tx) => {
      await lockPantry(tx, row.profileId, row.ingredientId);
      await tx.inventoryItem.deleteMany({ where: { id: row.id } });
    });
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile || profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Profile belongs to another user.' });
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ error: 'INVENTORY_ITEM_NOT_FOUND', message: 'Inventory item not found.' });
  }

  private async loadOwned(userId: string, id: string) {
    const row = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: { profile: true },
    });
    if (!row?.profile) throw this.notFound();
    if (row.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Inventory item belongs to another user.' });
    }
    return row;
  }

  private withIngredient(locale: Locale) {
    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    return { ingredient: { include: { translations: { where: { locale: { in: locales } } } } } } as const;
  }

  private parseDate(iso: string | null | undefined): Date | null {
    if (!iso) return null;
    return new Date(iso);
  }

  private toDto(
    row: {
      id: string;
      quantity: number;
      unit: 'g' | 'ml' | 'piece';
      bestBefore: Date | null;
      note: string | null;
      createdAt: Date;
      updatedAt: Date;
      ingredient: Parameters<typeof toIngredientDto>[0];
    },
    locale: Locale,
  ): InventoryItem {
    return {
      id: row.id,
      ingredient: toIngredientDto(row.ingredient, locale),
      quantity: row.quantity,
      unit: row.unit,
      display: displayStock(row.quantity, row.unit, row.ingredient),
      bestBefore: row.bestBefore ? row.bestBefore.toISOString().slice(0, 10) : null,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
