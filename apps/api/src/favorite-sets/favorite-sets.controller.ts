// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApplyFavoriteSetRequest, CreateFavoriteSetRequest, FavoriteSet, MealPlan, UpdateFavoriteSetRequest, type Locale } from '@diet-app/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { FavoriteSetsService } from './favorite-sets.service.js';

@Controller('favorite-sets')
@UseGuards(JwtAuthGuard)
export class FavoriteSetsController {
  constructor(private readonly sets: FavoriteSetsService) {}

  /** The favourite sets of a profile. */
  @Get()
  @AnswersListOf(FavoriteSet)
  list(@CurrentUser() user: RequestUser, @Query('profileId', requiredUuid) profileId: string) {
    return this.sets.list(user.id, profileId);
  }

  /** Make a set: a recipe for each meal it names. */
  @Post()
  @Answers(FavoriteSet)
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(CreateFavoriteSetRequest)) dto: CreateFavoriteSetRequest,
  ) {
    return this.sets.create(user.id, dto);
  }

  /** Change a set's name or its recipes. */
  @Patch(':id')
  @Answers(FavoriteSet)
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(UpdateFavoriteSetRequest)) dto: UpdateFavoriteSetRequest,
  ) {
    return this.sets.update(user.id, id, dto);
  }

  /** Delete a set. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string): Promise<void> {
    await this.sets.remove(user.id, id);
  }

  /** Put the recipes of a set on a day of a plan. */
  @Post(':id/apply')
  @Answers(MealPlan)
  apply(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(ApplyFavoriteSetRequest)) dto: ApplyFavoriteSetRequest,
  ) {
    return this.sets.apply(user.id, locale, id, dto);
  }
}
