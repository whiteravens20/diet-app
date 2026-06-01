import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiDraftRecipeRequest, type Locale } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AiRecipeDraftService } from './ai-recipe-draft.service.js';
import { RecipesService } from './recipes.service.js';

@Controller('recipes')
@UseGuards(JwtAuthGuard)
export class RecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly draft: AiRecipeDraftService,
  ) {}

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
   * Draft a brand-new recipe from a free-form prompt (F20). AI proposes the
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
}
