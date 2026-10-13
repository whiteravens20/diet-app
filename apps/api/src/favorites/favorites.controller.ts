// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AddFavoriteRequest, FavoriteListQuery, FavoriteMark, MarkedRecipe, type Locale } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { FavoritesService } from './favorites.service.js';

@Controller('favorites')
@UseGuards(JwtAuthGuard)
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  /** The recipes a profile marked, narrowed and ordered as asked. */
  @Get()
  @AnswersListOf(MarkedRecipe)
  list(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query(new ZodValidationPipe(FavoriteListQuery)) query: FavoriteListQuery,
  ) {
    const { profileId, ...filters } = query;
    return this.favorites.list(user.id, locale, profileId, filters);
  }

  /** Mark a recipe for a profile. Marking it again replaces what was said before. */
  @Post()
  @Answers(FavoriteMark)
  add(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(AddFavoriteRequest)) dto: AddFavoriteRequest) {
    return this.favorites.add(user.id, dto.profileId, dto.recipeId, dto.tags, dto.sentiment);
  }

  /** Take the mark off a recipe. */
  @Delete(':profileId/:recipeId')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('profileId', requiredUuid) profileId: string,
    @Param('recipeId', requiredUuid) recipeId: string,
  ) {
    await this.favorites.remove(user.id, profileId, recipeId);
  }
}
