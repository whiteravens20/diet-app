// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiDraftRecipeRequest, type Locale } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AiRecipeDraftService } from './ai-recipe-draft.service.js';
import { PersonalRecipesService } from './personal-recipes.service.js';
import { RecipesService } from './recipes.service.js';

@Controller('recipes')
@UseGuards(JwtAuthGuard)
export class RecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly draft: AiRecipeDraftService,
    private readonly personal: PersonalRecipesService,
  ) {}

  /**
   * "My Recipes" — list the requester's own non-deleted recipes (AI drafts +
   * ingredient-swap variants). Soft-deleted rows are filtered out.
   */
  @Get('mine')
  listMine(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.recipes.listMine(user.id, locale, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get()
  search(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query('search') search?: string,
    @Query('dietType') dietType?: string,
    @Query('mealType') mealType?: string,
    @Query('maxCalories') maxCalories?: string,
    @Query('maxPrepMinutes') maxPrepMinutes?: string,
    @Query('difficulty') difficulty?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.recipes.search(
      user.id,
      locale,
      {
        search,
        dietType,
        mealType,
        maxCalories: maxCalories ? Number(maxCalories) : undefined,
        maxPrepMinutes: maxPrepMinutes ? Number(maxPrepMinutes) : undefined,
        difficulty,
      },
      {
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
      },
    );
  }

  /**
   * Draft a brand-new recipe from a free-form prompt. AI proposes the
   * structure + ingredient choices; the deterministic engine recomputes
   * nutrition before persist. The recipe is private to the requester
   * (`origin='ai'` + owner-scoped privacy filter).
   */
  @Post('drafts/from-prompt')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  draftFromPrompt(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(AiDraftRecipeRequest)) dto: AiDraftRecipeRequest,
  ) {
    return this.draft.draftFromPrompt(user.id, locale, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @RequestLocale() locale: Locale, @Param('id') id: string) {
    return this.recipes.get(user.id, locale, id);
  }

  /**
   * Put a recipe of one's own before the curators, as a candidate for the
   * library everyone shares. They see what the recipe says and is made of,
   * not who sent it. Repeating the request changes nothing.
   */
  @Post(':id/submit')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(@CurrentUser() user: RequestUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.personal.submit(user.id, id);
  }

  /**
   * Soft-delete a recipe the user owns. Marks `deletedAt`; planned-meal
   * references stay intact so historical plans don't break. Curated / seed
   * rows can't be deleted (403). Idempotent — re-deleting is a no-op.
   */
  @Delete(':id')
  @HttpCode(204)
  delete(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<void> {
    return this.recipes.softDeleteMine(user.id, id);
  }
}
