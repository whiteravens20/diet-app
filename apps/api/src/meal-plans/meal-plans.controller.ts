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
import { Throttle } from '@nestjs/throttler';
import {
  AddCustomMealRequest,
  AiSuggestIngredientRequest,
  AiSwapMealRequest,
  GeneratePlanRequest,
  type Locale,
  RebalanceRequest,
  RegenerateRequest,
  SetMealEatenRequest,
  SwapIngredientRequest,
  SwapMealRequest,
} from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MealPlansService } from './meal-plans.service.js';

@Controller('meal-plans')
@UseGuards(JwtAuthGuard)
export class MealPlansController {
  constructor(private readonly plans: MealPlansService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query('profileId', requiredUuid) profileId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    return this.plans.list(user.id, locale, profileId, { from, to, status });
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @RequestLocale() locale: Locale, @Param('id') id: string) {
    return this.plans.get(user.id, locale, id);
  }

  /** Plan generation is rate-limited tighter — it is compute-heavy. */
  @Post('generate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  generate(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(GeneratePlanRequest)) dto: GeneratePlanRequest,
  ) {
    return this.plans.generate(user.id, locale, dto);
  }

  /** Re-run the optimiser for a whole plan, in place. */
  @Post(':id/regenerate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  regenerate(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RegenerateRequest)) options: RegenerateRequest,
  ) {
    return this.plans.regenerate(user.id, locale, id, options);
  }

  /** Re-roll the meals of a single day. */
  @Post(':id/days/:dayId/regenerate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  regenerateDay(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Param('dayId') dayId: string,
    @Body(new ZodValidationPipe(RegenerateRequest)) options: RegenerateRequest,
  ) {
    return this.plans.regenerateDay(user.id, locale, id, dayId, options);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.plans.remove(user.id, id);
  }

  @Post('swap-meal')
  swapMeal(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapMealRequest)) dto: SwapMealRequest,
  ) {
    return this.plans.swapMeal(user.id, locale, dto);
  }

  /** Add a user-authored custom meal to a day. */
  @Post(':id/days/:date/custom-meal')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  addCustomMeal(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Param('date') date: string,
    @Body(new ZodValidationPipe(AddCustomMealRequest)) dto: AddCustomMealRequest,
  ) {
    return this.plans.addCustomMeal(user.id, locale, id, date, dto);
  }

  /** Mark a planned meal eaten or not eaten (rebalances the day). */
  @Patch(':id/meals/:mealId/eaten')
  setEaten(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Param('mealId') mealId: string,
    @Body(new ZodValidationPipe(SetMealEatenRequest)) dto: SetMealEatenRequest,
  ) {
    return this.plans.setEaten(user.id, locale, id, mealId, dto.eaten);
  }

  /** Explicit rebalance (day / week) or undo via the `restore` map. */
  @Post(':id/rebalance')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  rebalance(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RebalanceRequest)) dto: RebalanceRequest,
  ) {
    return this.plans.rebalance(user.id, locale, id, dto);
  }

  /**
   * AI-ranked meal swap. The deterministic engine builds the candidate
   * pool; AI picks one. The response carries `aiMeta.fallbackReason` so the UI
   * can surface a localised toast when AI was unavailable.
   */
  @Post('ai-swap-meal')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  aiSwapMeal(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(AiSwapMealRequest)) dto: AiSwapMealRequest,
  ) {
    return this.plans.aiSwapMeal(user.id, locale, dto);
  }

  /**
   * AI-ranked ingredient suggestion. Returns just an `ingredientId`;
   * the caller still runs preview/apply so nutrition is engine-recomputed.
   */
  @Post('swap-ingredient/ai-suggest')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  aiSuggestIngredient(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(AiSuggestIngredientRequest)) dto: AiSuggestIngredientRequest,
  ) {
    return this.plans.aiSuggestIngredient(user.id, locale, dto);
  }

  @Post('swap-ingredient/preview')
  previewIngredientSwap(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.plans.previewIngredientSwap(user.id, dto);
  }

  /** Apply a substitution: clone the recipe with the swap baked in, repoint the meal. */
  @Post('swap-ingredient/apply')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  applyIngredientSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.plans.applyIngredientSwap(user.id, locale, dto);
  }
}
