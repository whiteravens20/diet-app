// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  dayAfter,
  FROZEN_KEEPS_DAYS,
  Unit,
  type FreezeInventoryItem,
  type InventoryItem,
  type Locale,
  type PatchInventoryItem,
  type UpsertInventoryItem,
} from '@diet-app/shared';
import { portionsOf } from '@diet-app/shared/portions';
import {
  convertUnit,
  displayStock,
  inAisleOrder,
  isCounted,
  UnitConversionError,
} from '../engine/index.js';
import { writeOnce } from '../common/idempotency.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toIngredientDto } from '../ingredients/ingredients.service.js';
import { assertRoomInPantry, assertWithinCeiling, lockPantry, newParcels } from './pantry-store.js';
import {
  forgetStock,
  lockStockRows,
  TRANSACTION,
} from '../shopping-lists/shopping-lists.service.js';

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
    });
    // Ordered here, not by the database: the names are those of the reader's language.
    const order = inAisleOrder(locale);
    return rows
      .map((r) => this.toDto(r, locale))
      .sort(
        (a, b) =>
          order(a.ingredient, b.ingredient) ||
          Unit.options.indexOf(a.unit) - Unit.options.indexOf(b.unit) ||
          a.id.localeCompare(b.id),
      );
  }

  /**
   * Upsert: posting `(profileId, ingredientId, unit)` that already exists
   * aggregates the quantity; otherwise creates a new row. `bestBefore`
   * overwrites when supplied so the latest update wins. What is counted goes
   * into its row in pieces, whatever unit it is given in. Sent again with its
   * key, the request is answered with the row the first one went to, as the
   * row is now, and adds nothing.
   */
  upsert(
    userId: string,
    locale: Locale,
    profileId: string,
    body: UpsertInventoryItem,
    key: string | null = null,
  ): Promise<InventoryItem> {
    return writeOnce(this.prisma, {
      userId,
      key,
      route: 'POST /inventory',
      request: { profileId, ...body },
      write: async (keep) => {
        await this.assertProfile(userId, profileId);
        const ingredient = await this.prisma.ingredient.findUnique({
          where: { id: body.ingredientId },
          select: {
            id: true,
            canonicalUnit: true,
            gramsPerPiece: true,
            density: true,
            displayUnit: true,
            retiredAt: true,
          },
        });
        // A food the catalogue retired is no new row, as it is no new entry of the diary or line of a recipe; what
        // the pantry still holds of it may be added to.
        const retiredAndNew =
          ingredient?.retiredAt != null &&
          (await this.prisma.inventoryItem.count({
            where: { profileId, ingredientId: ingredient.id },
          })) === 0;
        if (!ingredient || retiredAndNew) {
          throw new NotFoundException({
            error: 'INGREDIENT_NOT_FOUND',
            message: 'Ingredient not found.',
          });
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

        // Eggs, slices and cloves are counted, not weighed: never in the pantry twice.
        const unit = isCounted(ingredient) ? 'piece' : body.unit;
        const quantity = convertUnit(body.quantity, body.unit, unit, ingredient);

        // Into the freezer: packages of their own, as many as the portions, none adding to another.
        if (body.frozen) {
          const amounts = splitIntoPortions(quantity, unit, body.portions ?? 1);
          assertWithinCeiling(quantity, unit);
          const saved = await this.prisma.$transaction(async (tx) => {
            await lockPantry(tx, profileId, body.ingredientId);
            await assertRoomInPantry(tx, profileId, amounts.length);
            const parcels = await newParcels(tx, profileId, amounts.length);
            const rows = [];
            for (const [at, amount] of amounts.entries())
              rows.push(
                await tx.inventoryItem.create({
                  data: {
                    profileId,
                    ingredientId: body.ingredientId,
                    quantity: amount,
                    unit,
                    bestBefore: this.parseDate(body.bestBefore),
                    frozen: true,
                    parcel: parcels[at]!,
                  },
                  include: this.withIngredient(locale),
                }),
              );
            // Answered with the first package: the others are read with the pantry.
            await keep(tx, rows[0]!.id);
            return rows[0]!;
          });
          return this.toDto(saved, locale);
        }

        const where = {
          profileId_ingredientId_unit_frozen_parcel: {
            profileId,
            ingredientId: body.ingredientId,
            unit,
            frozen: false,
            parcel: 0,
          },
        };
        const saved = await this.prisma.$transaction(async (tx) => {
          await lockPantry(tx, profileId, body.ingredientId);
          const existing = await tx.inventoryItem.findUnique({ where });
          assertWithinCeiling((existing?.quantity ?? 0) + quantity, unit);
          if (!existing) await assertRoomInPantry(tx, profileId);
          const row = await tx.inventoryItem.upsert({
            where,
            create: {
              profileId,
              ingredientId: body.ingredientId,
              quantity,
              unit,
              bestBefore: this.parseDate(body.bestBefore),
            },
            update: {
              quantity: { increment: quantity },
              ...(body.bestBefore !== undefined
                ? { bestBefore: this.parseDate(body.bestBefore) }
                : {}),
            },
            include: this.withIngredient(locale),
          });
          await keep(tx, row.id);
          return row;
        });
        return this.toDto(saved, locale);
      },
      replay: (id) => this.read(userId, locale, id),
    });
  }

  async patch(
    userId: string,
    locale: Locale,
    id: string,
    body: PatchInventoryItem,
  ): Promise<InventoryItem> {
    const row = await this.loadOwned(userId, id);
    if (body.quantity !== undefined) assertWithinCeiling(body.quantity, row.unit);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockStockRows(tx, row.profileId, row.ingredientId);
      await lockPantry(tx, row.profileId, row.ingredientId);
      // A shopping row may have used the last of it since it was read.
      const changed = await tx.inventoryItem.updateMany({
        where: { id: row.id },
        data: {
          ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
          ...(body.bestBefore !== undefined ? { bestBefore: this.parseDate(body.bestBefore) } : {}),
        },
      });
      if (changed.count === 0) throw this.notFound();
      // Less of it at home: the lists count on no more than there is.
      if (body.quantity !== undefined) await forgetStock(tx, row.profileId, row.ingredientId, null);
      return tx.inventoryItem.findUniqueOrThrow({
        where: { id: row.id },
        include: this.withIngredient(locale),
      });
    }, TRANSACTION);
    return this.toDto(updated, locale);
  }

  /**
   * "Zamroź": a fresh row goes into the freezer, split into `portions` packages of their own as evenly as its unit
   * allows (`splitIntoPortions`), each dated `FROZEN_KEEPS_DAYS` from the client's day (the server's where it names
   * none); none adds to a package there is. Answered with the profile's pantry as it is then; a row already frozen
   * leaves it as it is. Sent again with the same `Idempotency-Key`, it is answered with the pantry as it is now.
   */
  freeze(
    userId: string,
    locale: Locale,
    id: string,
    body: FreezeInventoryItem,
    clientToday: string | null,
    key: string | null = null,
  ): Promise<InventoryItem[]> {
    return writeOnce(this.prisma, {
      userId,
      key,
      route: 'POST /inventory/:id/freeze',
      request: { id, ...body },
      write: async (keep) => {
        const row = await this.loadOwned(userId, id);
        const bestBefore = new Date(
          dayAfter(clientToday ?? new Date().toISOString().slice(0, 10), FROZEN_KEEPS_DAYS),
        );
        await this.prisma.$transaction(async (tx) => {
          await lockPantry(tx, row.profileId, row.ingredientId);
          // A shopping row may have used the last of it, or another request frozen it, since it was read.
          const fresh = await tx.inventoryItem.findUnique({ where: { id: row.id } });
          if (!fresh) throw this.notFound();
          await keep(tx, fresh.profileId);
          if (fresh.frozen) return;
          const amounts = splitIntoPortions(fresh.quantity, fresh.unit, body.portions ?? 1);
          await assertRoomInPantry(tx, fresh.profileId, amounts.length - 1);
          const parcels = await newParcels(tx, fresh.profileId, amounts.length);
          await tx.inventoryItem.delete({ where: { id: fresh.id } });
          for (const [at, amount] of amounts.entries())
            await tx.inventoryItem.create({
              data: {
                profileId: fresh.profileId,
                ingredientId: fresh.ingredientId,
                unit: fresh.unit,
                quantity: amount,
                bestBefore,
                frozen: true,
                parcel: parcels[at]!,
              },
            });
        });
        return this.list(userId, locale, row.profileId);
      },
      replay: (profileId) => this.list(userId, locale, profileId),
    });
  }

  /**
   * A row removed is food that is not at home: what the profile's lists took of it, or count on, goes with it
   * (`forgetStock`), and nothing of it comes back when a list is removed.
   */
  async remove(userId: string, id: string): Promise<void> {
    const row = await this.loadOwned(userId, id);
    await this.prisma.$transaction(async (tx) => {
      await lockStockRows(tx, row.profileId, row.ingredientId);
      await lockPantry(tx, row.profileId, row.ingredientId);
      const gone = await tx.inventoryItem.findUnique({ where: { id: row.id } });
      if (!gone) return;
      await tx.inventoryItem.delete({ where: { id: gone.id } });
      await forgetStock(tx, gone.profileId, gone.ingredientId, gone);
    }, TRANSACTION);
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile || profile.userId !== userId)
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
  }

  /** A row of one of the user's pantries, as it is now. */
  private async read(userId: string, locale: Locale, id: string): Promise<InventoryItem> {
    const row = await this.prisma.inventoryItem.findFirst({
      where: { id, profile: { userId } },
      include: this.withIngredient(locale),
    });
    if (!row) throw this.notFound();
    return this.toDto(row, locale);
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      error: 'INVENTORY_ITEM_NOT_FOUND',
      message: 'Inventory item not found.',
    });
  }

  private async loadOwned(userId: string, id: string) {
    const row = await this.prisma.inventoryItem.findUnique({
      where: { id },
      include: { profile: true },
    });
    if (!row?.profile || row.profile.userId !== userId) throw this.notFound();
    return row;
  }

  private withIngredient(locale: Locale) {
    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    return {
      ingredient: { include: { translations: { where: { locale: { in: locales } } } } },
    } as const;
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
      frozen: boolean;
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
      frozen: row.frozen,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** `quantity` of `unit` split into `portions` packages (`portionsOf`), or refused where a part would hold less than one. */
function splitIntoPortions(
  quantity: number,
  unit: 'g' | 'ml' | 'piece',
  portions: number,
): number[] {
  const amounts = portionsOf(quantity, portions);
  if (!amounts)
    throw new BadRequestException({
      error: 'PORTIONS_TOO_MANY',
      message: `There is not enough of it for ${portions} portions of at least one ${unit} each: split it into fewer.`,
    });
  return amounts;
}
