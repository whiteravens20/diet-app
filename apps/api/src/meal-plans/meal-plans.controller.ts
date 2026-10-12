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
  ApplyMealSwapRequest,
  GeneratePlanRequest,
  PlanCalendarQuery,
  PlanListQuery,
  PlanOverviewQuery,
  type Locale,
  RebalanceRequest,
  RegenerateDayRequest,
  RegenerateRequest,
  SetMealEatenRequest,
  SwapIngredientRequest,
  SwapMealRequest,
  WeighRequest,
} from '@diet-app/shared';
import { ClientDate } from '../common/client-date.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { requiredDate, requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { IngredientSwapService } from './ingredient-swap.service.js';
import { MealPlansService } from './meal-plans.service.js';
import { MealSwapService } from './meal-swap.service.js';
import { PlanCalendarService } from './plan-calendar.service.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { PlanOverviewService } from './plan-overview.service.js';
import { UseUpService } from './use-up.service.js';

@Controller('meal-plans')
@UseGuards(JwtAuthGuard)
export class MealPlansController {
  constructor(
    private readonly plans: MealPlansService,
    private readonly generation: PlanGenerationService,
    private readonly ingredients: IngredientSwapService,
    private readonly swaps: MealSwapService,
    private readonly overviews: PlanOverviewService,
    private readonly calendars: PlanCalendarService,
    private readonly useUp: UseUpService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(PlanListQuery)) query: PlanListQuery,
    @ClientDate() today: string | null,
  ) {
    return this.plans.list(user.id, query, today);
  }

  /** What the profile's plan of the moment comes to. Declared before the route of one plan, whose id it is not. */
  @Get('overview')
  overview(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query(new ZodValidationPipe(PlanOverviewQuery)) query: PlanOverviewQuery,
    @ClientDate() today: string | null,
  ) {
    return this.overviews.overview(user.id, locale, query.profileId, today);
  }

  /**
   * The days of the profile's plans in a span of days, for a calendar.
   * Declared before the route of one plan, whose id it is not. A calendar is
   * leafed through a month at a time, and a month is one request: the limit
   * is that of somebody who leafs fast.
   */
  @Get('calendar')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  calendar(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(PlanCalendarQuery)) query: PlanCalendarQuery) {
    return this.calendars.calendar(user.id, query);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @RequestLocale() locale: Locale, @Param('id', requiredUuid) id: string) {
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
    return this.generation.generate(user.id, locale, dto);
  }

  /** Make a plan again, or the days of it that the request names. */
  @Post(':id/regenerate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  regenerate(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(RegenerateRequest)) options: RegenerateRequest,
    @ClientDate() today: string | null,
  ) {
    return this.generation.regenerate(user.id, locale, id, options, today);
  }

  /** Re-roll the meals of a single day. */
  @Post(':id/days/:dayId/regenerate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  regenerateDay(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('dayId', requiredUuid) dayId: string,
    @Body(new ZodValidationPipe(RegenerateDayRequest)) options: RegenerateDayRequest,
    @ClientDate() today: string | null,
  ) {
    return this.generation.regenerateDay(user.id, locale, id, dayId, options, today);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.plans.remove(user.id, id);
  }

  /** A recipe to put in the place of a planned meal, with what the swap would do. Nothing is written. */
  @Post('swap-meal/preview')
  previewSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapMealRequest)) dto: SwapMealRequest,
  ) {
    return this.swaps.preview(user.id, locale, dto);
  }

  /** Make a swap that was offered, on the plan as it was when the offer was made. */
  @Post('swap-meal')
  applySwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(ApplyMealSwapRequest)) dto: ApplyMealSwapRequest,
  ) {
    return this.swaps.apply(user.id, locale, dto);
  }

  /** Add a user-authored custom meal to a day. */
  @Post(':id/days/:date/custom-meal')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  addCustomMeal(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('date', requiredDate) date: string,
    @Body(new ZodValidationPipe(AddCustomMealRequest)) dto: AddCustomMealRequest,
  ) {
    return this.plans.addCustomMeal(user.id, locale, id, date, dto);
  }

  /** Mark a planned meal eaten or not eaten (rebalances the day). */
  @Patch(':id/meals/:mealId/eaten')
  setEaten(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('mealId', requiredUuid) mealId: string,
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
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(RebalanceRequest)) dto: RebalanceRequest,
    @ClientDate() today: string | null,
  ) {
    return this.plans.rebalance(user.id, locale, id, dto, today);
  }

  /**
   * The same offer, with a model asked which of the recipes the engine puts
   * before it to take. `aiMeta` says who picked; nothing is written.
   */
  @Post('ai-swap-meal/preview')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  previewAiSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(AiSwapMealRequest)) dto: AiSwapMealRequest,
  ) {
    return this.swaps.previewWithAi(user.id, locale, dto);
  }

  /**
   * Swaps that would use up what the plan opens: the engine finds them, and a
   * model puts them in order and says a sentence of each when the request
   * asks for one. Nothing is written; a suggestion is taken as any swap is.
   * The limit is that of making a plan: every meal of the plan is looked at.
   */
  @Post(':id/use-up')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  useUpSuggestions(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(WeighRequest)) dto: WeighRequest,
    @ClientDate() today: string | null,
  ) {
    return this.useUp.suggest(user.id, locale, id, dto, today);
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
    return this.ingredients.aiSuggestIngredient(user.id, locale, dto);
  }

  /** The substitutes the catalogue's own rules name for the ingredients of a planned meal. */
  @Get(':id/meals/:mealId/substitutes')
  substitutes(@CurrentUser() user: RequestUser, @RequestLocale() locale: Locale, @Param('id', requiredUuid) id: string, @Param('mealId', requiredUuid) mealId: string) {
    return this.ingredients.suggestions(user.id, locale, id, mealId);
  }

  @Post('swap-ingredient/preview')
  previewIngredientSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.ingredients.previewIngredientSwap(user.id, locale, dto);
  }

  /** Apply a substitution: clone the recipe with the swap baked in, repoint the meal. */
  @Post('swap-ingredient/apply')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  applyIngredientSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.ingredients.applyIngredientSwap(user.id, locale, dto);
  }
}
