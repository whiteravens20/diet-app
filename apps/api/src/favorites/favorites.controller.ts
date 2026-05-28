import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Locale } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { FavoritesService } from './favorites.service.js';

const AddFavorite = z.object({
  profileId: z.string().uuid(),
  recipeId: z.string().uuid(),
  tags: z.array(z.string()).default([]),
  sentiment: z.enum(['favorite', 'often', 'avoid']).default('favorite'),
});
type AddFavorite = z.infer<typeof AddFavorite>;

@Controller('favorites')
@UseGuards(JwtAuthGuard)
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query('profileId') profileId: string,
    @Query('search') search?: string,
    @Query('mealType') mealType?: string,
  ) {
    return this.favorites.list(user.id, locale, profileId, { search, mealType });
  }

  @Post()
  add(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(AddFavorite)) dto: AddFavorite) {
    return this.favorites.add(user.id, dto.profileId, dto.recipeId, dto.tags, dto.sentiment);
  }

  @Delete(':profileId/:recipeId')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('profileId') profileId: string,
    @Param('recipeId') recipeId: string,
  ) {
    await this.favorites.remove(user.id, profileId, recipeId);
  }
}
