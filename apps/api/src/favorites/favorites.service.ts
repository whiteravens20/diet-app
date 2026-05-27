import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { toRecipeDto } from '../recipes/recipes.service.js';

/** Per-profile favorite recipes, with tags and a sentiment signal. */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    profileId: string,
    filters: { search?: string; mealType?: string } = {},
  ) {
    await this.assertProfile(userId, profileId);
    const rows = await this.prisma.favorite.findMany({
      where: {
        profileId,
        recipe: {
          ...(filters.search
            ? { title: { contains: filters.search, mode: 'insensitive' } }
            : {}),
          ...(filters.mealType ? { mealTypes: { has: filters.mealType } } : {}),
        },
      },
      include: { recipe: { include: { ingredients: { include: { ingredient: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((f) => ({
      id: f.id,
      tags: f.tags,
      sentiment: f.sentiment,
      recipe: toRecipeDto(f.recipe),
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
}
