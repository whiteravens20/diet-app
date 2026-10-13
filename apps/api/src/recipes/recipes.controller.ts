// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiDraftRecipeRequest, AiDraftRecipeResponse, PageQuery, Recipe, RecipeSearchPage, RecipeSearchQuery, type Locale } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { Answers } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
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
   * The recipes of the account's own, a page at a time: those a model wrote
   * for it and those a substitution left. A deleted one is not among them.
   */
  @Get('mine')
  @Answers(RecipeSearchPage)
  listMine(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query(new ZodValidationPipe(PageQuery)) paging: PageQuery,
  ) {
    return this.recipes.listMine(user.id, locale, paging);
  }

  /** The recipe library: the shared recipes and the account's own, narrowed as asked, a page at a time. */
  @Get()
  @Answers(RecipeSearchPage)
  search(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query(new ZodValidationPipe(RecipeSearchQuery)) query: RecipeSearchQuery,
  ) {
    const { page, pageSize, ...filters } = query;
    return this.recipes.search(user.id, locale, filters, { page, pageSize });
  }

  /**
   * Ask a model for a recipe of the account's own, from the choices the
   * request names: the meal, the diet, the cuisine, the energy, the time.
   * There is no text of the user's in the request. The model chooses among
   * the ingredients of the catalogue, the engine works out the nutrition, and
   * the recipe is the account's alone.
   */
  @Post('drafts/from-prompt')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Answers(AiDraftRecipeResponse)
  draftFromPrompt(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(AiDraftRecipeRequest)) dto: AiDraftRecipeRequest,
  ) {
    return this.draft.draftFromPrompt(user.id, locale, dto);
  }

  /** One recipe, with its ingredients and steps. */
  @Get(':id')
  @Answers(Recipe)
  get(@CurrentUser() user: RequestUser, @RequestLocale() locale: Locale, @Param('id', requiredUuid) id: string) {
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
  submit(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string): Promise<void> {
    return this.personal.submit(user.id, id);
  }

  /**
   * Delete a recipe of the account's own. The plans that hold it keep it; a
   * recipe of the shared library cannot be deleted (403). Deleting it again
   * changes nothing.
   */
  @Delete(':id')
  @HttpCode(204)
  delete(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string): Promise<void> {
    return this.recipes.softDeleteMine(user.id, id);
  }
}
