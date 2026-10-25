// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  FavoriteSentiment,
  MAX_FAVORITES_PER_PROFILE,
  type FavoriteListQuery,
  type FavoriteSort,
  type Locale,
  type MarkedRecipe,
} from '@diet-app/shared';
import { holdProfile } from '../common/hold.js';
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
    filters: Omit<FavoriteListQuery, 'profileId' | 'sort'> & { sort?: FavoriteSort } = {},
  ): Promise<MarkedRecipe[]> {
    await this.assertProfile(userId, profileId);
    const trWhere = locale === 'en' ? ['en'] : [locale, 'en'];
    const rows = await this.prisma.favorite.findMany({
      where: {
        profileId,
        ...(filters.sentiment ? { sentiment: filters.sentiment } : {}),
        ...(filters.tag ? { tags: { has: filters.tag } } : {}),
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
    const marked = rows.map((f) => ({
      id: f.id,
      tags: f.tags,
      sentiment: FavoriteSentiment.parse(f.sentiment),
      markedAt: f.createdAt.toISOString(),
      recipe: toRecipeDto(f.recipe, locale),
    }));
    // A profile has at most a few hundred marks: they are put in order here, by the title as the reader sees it.
    if (filters.sort === 'title')
      return marked.sort(
        (a, b) => a.recipe.title.localeCompare(b.recipe.title, locale) || a.id.localeCompare(b.id),
      );
    if (filters.sort === 'calories')
      return marked.sort(
        (a, b) =>
          a.recipe.nutritionPerServing.calories - b.recipe.nutritionPerServing.calories ||
          a.id.localeCompare(b.id),
      );
    return marked;
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
    const key = { profileId_recipeId: { profileId, recipeId } };
    return this.prisma.$transaction(async (tx) => {
      await holdProfile(tx, profileId);
      // Saying something else about a recipe that is marked already adds nothing. What counts is what the list shows.
      const marked = await tx.favorite.findUnique({ where: key, select: { id: true } });
      if (
        !marked &&
        (await tx.favorite.count({ where: { profileId, recipe: { deletedAt: null } } })) >=
          MAX_FAVORITES_PER_PROFILE
      ) {
        throw new ConflictException({
          error: 'FAVORITE_LIMIT_REACHED',
          message: `A profile can have at most ${MAX_FAVORITES_PER_PROFILE} marked recipes. Remove a mark to add another.`,
        });
      }
      return tx.favorite.upsert({
        where: key,
        create: { profileId, recipeId, tags, sentiment },
        update: { tags, sentiment },
      });
    });
  }

  async remove(userId: string, profileId: string, recipeId: string): Promise<void> {
    await this.assertProfile(userId, profileId);
    const removed = await this.prisma.favorite.deleteMany({ where: { profileId, recipeId } });
    if (removed.count === 0) {
      throw new NotFoundException({
        error: 'FAVORITE_NOT_FOUND',
        message: 'That recipe is not marked for this profile.',
      });
    }
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile || profile.userId !== userId)
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
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
