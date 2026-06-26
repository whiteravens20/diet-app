// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Locale } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { searchMatch, toRecipeDto } from '../recipes/recipes.service.js';

/** Per-profile favorite recipes, with tags and a sentiment signal. */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    locale: Locale,
    profileId: string,
    filters: { search?: string; mealType?: string } = {},
  ) {
    await this.assertProfile(userId, profileId);
    const trWhere = locale === 'en' ? ['en'] : [locale, 'en'];
    const rows = await this.prisma.favorite.findMany({
      where: {
        profileId,
        // Defence-in-depth: never surface a favorite whose recipe is now
        // soft-deleted, or (for any row created before the `add` guard) is
        // private to another user. `add` already blocks creating such a row.
        recipe: {
          deletedAt: null,
          OR: [{ createdByUserId: null }, { createdByUserId: userId }],
          AND: [
            ...(filters.search ? [searchMatch(filters.search, locale)] : []),
            ...(filters.mealType ? [{ mealTypes: { has: filters.mealType } }] : []),
          ],
        },
      },
      include: {
        recipe: {
          include: {
            ingredients: {
              include: {
                ingredient: { include: { translations: { where: { locale: { in: trWhere } } } } },
              },
            },
            translations: { where: { locale: { in: trWhere } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((f) => ({
      id: f.id,
      tags: f.tags,
      sentiment: f.sentiment,
      recipe: toRecipeDto(f.recipe, locale),
    }));
  }

  async add(
    userId: string,
    profileId: string,
    recipeId: string,
    tags: string[],
    sentiment: string,
  ) {
    await this.assertProfile(userId, profileId);
    await this.assertRecipeVisible(userId, recipeId);
    return this.prisma.favorite.upsert({
      where: { profileId_recipeId: { profileId, recipeId } },
      create: { profileId, recipeId, tags, sentiment },
      update: { tags, sentiment },
    });
  }

  async remove(userId: string, profileId: string, recipeId: string): Promise<void> {
    await this.assertProfile(userId, profileId);
    await this.prisma.favorite
      .delete({ where: { profileId_recipeId: { profileId, recipeId } } })
      .catch(() => undefined);
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile || profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Profile belongs to another user.' });
    }
  }

  /**
   * A favorite may only point at a recipe the user can actually see — a
   * curated/public row (`createdByUserId` null) or their own non-deleted
   * recipe. Without this a user could favorite another user's private
   * AI-drafted recipe and read its full content back through `list` (IDOR).
   * Mirrors the recipes-service visibility filter and the favorite-sets guard.
   */
  private async assertRecipeVisible(userId: string, recipeId: string): Promise<void> {
    const recipe = await this.prisma.recipe.findFirst({
      where: {
        id: recipeId,
        deletedAt: null,
        OR: [{ createdByUserId: null }, { createdByUserId: userId }],
      },
      select: { id: true },
    });
    if (!recipe) {
      throw new NotFoundException({ error: 'RECIPE_NOT_FOUND', message: 'Recipe not found.' });
    }
  }
}
