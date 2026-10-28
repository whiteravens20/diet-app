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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AddCustomMealRequest,
  AiMealSwapPreview,
  AiSuggestIngredientRequest,
  AiSuggestIngredientResponse,
  AiSwapMealRequest,
  ApplyDaySettingsRequest,
  ApplyMealSwapRequest,
  DaySettings,
  DaySettingsPreview,
  DayVariations,
  GeneratePlanRequest,
  MealPlan,
  MealPlanPage,
  MealSwapPreview,
  PlanCalendar,
  PlanCalendarQuery,
  PlanListQuery,
  PlanOverviewAnswer,
  PlanOverviewQuery,
  RebalanceRequest,
  RebalanceResult,
  RegenerateDayRequest,
  RegenerateRequest,
  RerollPreview,
  SetMealEatenRequest,
  SubstituteSuggestion,
  SwapIngredientRequest,
  SwapIngredientResponse,
  SwapMealRequest,
  SwapPreview,
  TakeDayVariationRequest,
  UseUpSuggestions,
  WeighRequest,
  type Locale,
} from '@diet-app/shared';
import { ClientDate } from '../common/client-date.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { IdempotencyKey } from '../common/idempotency-key.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { requiredDate, requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { DaySettingsService } from './day-settings.service.js';
import { DayVariationsService } from './day-variations.service.js';
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
    private readonly variations: DayVariationsService,
    private readonly settings: DaySettingsService,
  ) {}

  /** The plans of a profile, a page at a time, narrowed by their days and by whether they are over. */
  @Get()
  @Answers(MealPlanPage)
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(PlanListQuery)) query: PlanListQuery,
    @ClientDate() today: string | null,
  ) {
    return this.plans.list(user.id, query, today);
  }

  /**
   * What the profile's plan of the moment comes to.
   *
   * Declared before the route of one plan, whose id it is not.
   */
  @Get('overview')
  @Answers(PlanOverviewAnswer)
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
   *
   * Declared before the route of one plan, whose id it is not. A calendar is
   * leafed through a month at a time, and a month is one request: the limit
   * is that of somebody who leafs fast.
   */
  @Get('calendar')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(PlanCalendar)
  calendar(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(PlanCalendarQuery)) query: PlanCalendarQuery,
  ) {
    return this.calendars.calendar(user.id, query);
  }

  /** One plan, with its days and their meals. */
  @Get(':id')
  @Answers(MealPlan)
  get(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
  ) {
    return this.plans.get(user.id, locale, id);
  }

  /**
   * Make a plan for a profile: the planner fills its days within the limits
   * of the profile. 422 `PLAN_NEEDS_RELAXATION` when it cannot, with the
   * limits that would have to give way.
   *
   * Limited more tightly than other routes: choosing the recipes is work of
   * the API process.
   */
  @Post('generate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(MealPlan)
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
  @Answers(MealPlan)
  regenerate(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(RegenerateRequest)) options: RegenerateRequest,
    @ClientDate() today: string | null,
  ) {
    return this.generation.regenerate(user.id, locale, id, options, today);
  }

  /**
   * What making a plan again, or the days of it that the request names, would
   * do to it as it stands: the days and the meals replaced, and what is kept
   * and why, read as the re-roll reads the plan. Nothing is drawn and nothing
   * is written. Asked again as the choice changes in a window, so it is held
   * to what a window asks for in a minute.
   */
  @Post(':id/regenerate/preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(RerollPreview)
  previewRegenerate(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(RegenerateRequest)) request: RegenerateRequest,
    @ClientDate() today: string | null,
  ) {
    const { from, to, ...options } = request;
    return this.generation.previewReroll(user.id, id, { from, to }, options, today);
  }

  /** What re-rolling the meals of a single day would do, as the preview of the plan says it of that day. */
  @Post(':id/days/:dayId/regenerate/preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(RerollPreview)
  previewRegenerateDay(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @Param('dayId', requiredUuid) dayId: string,
    @Body(new ZodValidationPipe(RegenerateDayRequest)) options: RegenerateDayRequest,
    @ClientDate() today: string | null,
  ) {
    return this.generation.previewRerollDay(user.id, id, dayId, options, today);
  }

  /** Re-roll the meals of a single day. */
  @Post(':id/days/:dayId/regenerate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(MealPlan)
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

  /**
   * Other ways to fill a day: the engine makes them as it makes a day again,
   * and a model puts them in order and says a sentence of each when the
   * request asks for one. Nothing is written. One request makes the day up
   * to eight times over, so it is held to half of what making a day again is.
   */
  @Post(':id/days/:dayId/variations')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Answers(DayVariations)
  dayVariations(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('dayId', requiredUuid) dayId: string,
    @Body(new ZodValidationPipe(WeighRequest)) dto: WeighRequest,
    @ClientDate() today: string | null,
  ) {
    return this.variations.offer(user.id, locale, id, dayId, dto, today);
  }

  /** Fill a day the way it was offered. */
  @Post(':id/days/:dayId/variations/take')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(MealPlan)
  takeDayVariation(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('dayId', requiredUuid) dayId: string,
    @Body(new ZodValidationPipe(TakeDayVariationRequest)) dto: TakeDayVariationRequest,
  ) {
    return this.variations.take(user.id, locale, id, dayId, dto);
  }

  /**
   * What changing the settings of a day would do: its target, and which of
   * its meals stay, change their amount, get another recipe or go. Nothing is
   * written. Asked again as the settings are changed in a window, so it is
   * held to what a window asks for in a minute.
   */
  @Post(':id/days/:dayId/settings/preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(DaySettingsPreview)
  previewDaySettings(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @Param('dayId', requiredUuid) dayId: string,
    @Body(new ZodValidationPipe(DaySettings)) dto: DaySettings,
    @ClientDate() today: string | null,
  ) {
    return this.settings.preview(user.id, id, dayId, dto, today);
  }

  /** Change the settings of a day of a running plan, as the preview at `revision` said. Draws recipes as making the day again does. */
  @Put(':id/days/:dayId/settings')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(MealPlan)
  applyDaySettings(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('dayId', requiredUuid) dayId: string,
    @Body(new ZodValidationPipe(ApplyDaySettingsRequest)) dto: ApplyDaySettingsRequest,
    @ClientDate() today: string | null,
  ) {
    return this.settings.apply(user.id, locale, id, dayId, dto, today);
  }

  /** Delete a plan. Its shopping lists go with it, and what was obtained for days still ahead goes into the pantry. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.plans.remove(user.id, id);
  }

  /** A recipe to put in the place of a planned meal, with what the swap would do. Nothing is written. */
  @Post('swap-meal/preview')
  @Answers(MealSwapPreview)
  previewSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapMealRequest)) dto: SwapMealRequest,
  ) {
    return this.swaps.preview(user.id, locale, dto);
  }

  /** Make a swap that was offered, on the plan as it was when the offer was made. */
  @Post('swap-meal')
  @Answers(RebalanceResult)
  applySwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(ApplyMealSwapRequest)) dto: ApplyMealSwapRequest,
  ) {
    return this.swaps.apply(user.id, locale, dto);
  }

  /**
   * Add a user-authored custom meal to a day. Sent again with the same
   * `Idempotency-Key` within a week, it is answered with the plan as it is now,
   * without a rebalance, and adds nothing.
   */
  @Post(':id/days/:date/custom-meal')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(RebalanceResult)
  addCustomMeal(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @IdempotencyKey() key: string | null,
    @Param('id', requiredUuid) id: string,
    @Param('date', requiredDate) date: string,
    @Body(new ZodValidationPipe(AddCustomMealRequest)) dto: AddCustomMealRequest,
  ) {
    return this.plans.addCustomMeal(user.id, locale, id, date, dto, key);
  }

  /** Take a meal off its day, whichever it is (rebalances the day). */
  @Delete(':id/meals/:mealId')
  @Answers(RebalanceResult)
  removeMeal(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('mealId', requiredUuid) mealId: string,
  ) {
    return this.plans.removeMeal(user.id, locale, id, mealId);
  }

  /** Mark a planned meal eaten or not eaten (rebalances the day). */
  @Patch(':id/meals/:mealId/eaten')
  @Answers(RebalanceResult)
  setEaten(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('mealId', requiredUuid) mealId: string,
    @Body(new ZodValidationPipe(SetMealEatenRequest)) dto: SetMealEatenRequest,
  ) {
    return this.plans.setEaten(user.id, locale, id, mealId, dto.eaten);
  }

  /** Share what a day, or the rest of the plan, has left among its meals again, or put servings back as the `restore` of an earlier answer says. */
  @Post(':id/rebalance')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(RebalanceResult)
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
   * A recipe to put in the place of a planned meal, as `swap-meal/preview`
   * offers one, with a model asked which of the recipes the engine puts
   * before it to take. `aiMeta` says who picked; nothing is written.
   */
  @Post('ai-swap-meal/preview')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(AiMealSwapPreview)
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
  @Answers(UseUpSuggestions)
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
  @Answers(AiSuggestIngredientResponse)
  aiSuggestIngredient(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(AiSuggestIngredientRequest)) dto: AiSuggestIngredientRequest,
  ) {
    return this.ingredients.aiSuggestIngredient(user.id, locale, dto);
  }

  /** The substitutes the catalogue's own rules name for the ingredients of a planned meal. */
  @Get(':id/meals/:mealId/substitutes')
  @AnswersListOf(SubstituteSuggestion)
  substitutes(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('mealId', requiredUuid) mealId: string,
  ) {
    return this.ingredients.suggestions(user.id, locale, id, mealId);
  }

  /** What swapping an ingredient of a meal for another would do to the meal. Nothing is written. */
  @Post('swap-ingredient/preview')
  @Answers(SwapPreview)
  previewIngredientSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.ingredients.previewIngredientSwap(user.id, locale, dto);
  }

  /** Make a substitution: the meal gets a recipe of the account's own, the planned one with the ingredient swapped. */
  @Post('swap-ingredient/apply')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(SwapIngredientResponse)
  applyIngredientSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.ingredients.applyIngredientSwap(user.id, locale, dto);
  }
}
