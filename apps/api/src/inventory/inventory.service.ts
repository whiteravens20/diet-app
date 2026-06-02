import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { InventoryItem, Locale, PatchInventoryItem, UpsertInventoryItem } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { toIngredientDto } from '../ingredients/ingredients.service.js';

/**
 * F15 per-profile pantry. CRUD + the read path the optimiser uses for
 * coverage scoring. Mutations are all profile-scoped and authorise against
 * the calling user.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, locale: Locale, profileId: string): Promise<InventoryItem[]> {
    await this.assertProfile(userId, profileId);
    const trWhere = locale === 'en' ? ['en'] : [locale, 'en'];
    const rows = await this.prisma.inventoryItem.findMany({
      where: { profileId },
      include: { ingredient: { include: { translations: { where: { locale: { in: trWhere } } } } } },
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
    const existing = await this.prisma.inventoryItem.findUnique({
      where: {
        profileId_ingredientId_unit: {
          profileId,
          ingredientId: body.ingredientId,
          unit: body.unit,
        },
      },
    });
    const updated = existing
      ? await this.prisma.inventoryItem.update({
          where: { id: existing.id },
          data: {
            quantity: existing.quantity + body.quantity,
            bestBefore: body.bestBefore !== undefined ? this.parseDate(body.bestBefore) : existing.bestBefore,
            note: body.note !== undefined ? body.note : existing.note,
          },
          include: { ingredient: { include: { translations: { where: { locale: { in: this.trLocales(locale) } } } } } },
        })
      : await this.prisma.inventoryItem.create({
          data: {
            profileId,
            ingredientId: body.ingredientId,
            quantity: body.quantity,
            unit: body.unit,
            bestBefore: this.parseDate(body.bestBefore),
            note: body.note ?? null,
          },
          include: { ingredient: { include: { translations: { where: { locale: { in: this.trLocales(locale) } } } } } },
        });
    return this.toDto(updated, locale);
  }

  async patch(userId: string, locale: Locale, id: string, body: PatchInventoryItem): Promise<InventoryItem> {
    const row = await this.loadOwned(userId, id);
    const updated = await this.prisma.inventoryItem.update({
      where: { id: row.id },
      data: {
        quantity: body.quantity ?? row.quantity,
        bestBefore: body.bestBefore !== undefined ? this.parseDate(body.bestBefore) : row.bestBefore,
        note: body.note !== undefined ? body.note : row.note,
      },
      include: { ingredient: { include: { translations: { where: { locale: { in: this.trLocales(locale) } } } } } },
    });
    return this.toDto(updated, locale);
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = await this.loadOwned(userId, id);
    await this.prisma.inventoryItem.delete({ where: { id: row.id } });
  }

  /**
   * Map of `ingredientId → quantity` in the canonical unit. Read by the
   * optimiser to score recipe coverage. Aggregates across units by
   * converting non-canonical rows via the engine's unit converter at call
   * time (see optimiser integration).
   */
  async snapshot(profileId: string): Promise<Array<{ ingredientId: string; quantity: number; unit: 'g' | 'ml' | 'piece' }>> {
    const rows = await this.prisma.inventoryItem.findMany({
      where: { profileId },
      select: { ingredientId: true, quantity: true, unit: true },
    });
    return rows;
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile || profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Profile belongs to another user.' });
    }
  }

  private async loadOwned(userId: string, id: string) {
    const row = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: { profile: true },
    });
    if (!row) {
      throw new NotFoundException({ error: 'INVENTORY_ITEM_NOT_FOUND', message: 'Inventory item not found.' });
    }
    if (row.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Inventory item belongs to another user.' });
    }
    return row;
  }

  private trLocales(locale: Locale): string[] {
    return locale === 'en' ? ['en'] : [locale, 'en'];
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
      bestBefore: row.bestBefore ? row.bestBefore.toISOString().slice(0, 10) : null,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
