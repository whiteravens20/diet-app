import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AiSwapMealRequest,
  GeneratePlanRequest,
  type Locale,
  SwapIngredientRequest,
  SwapMealRequest,
} from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
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
    @Query('profileId') profileId: string,
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
  ) {
    return this.plans.regenerate(user.id, locale, id);
  }

  /** Re-roll the meals of a single day. */
  @Post(':id/days/:dayId/regenerate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  regenerateDay(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Param('dayId') dayId: string,
  ) {
    return this.plans.regenerateDay(user.id, locale, id, dayId);
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

  /**
   * AI-ranked meal swap (F20). The deterministic engine builds the candidate
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

  @Post('swap-ingredient/preview')
  previewIngredientSwap(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.plans.previewIngredientSwap(user.id, dto);
  }

  /** Apply a substitution: clone the recipe with the swap baked in, repoint the meal. */
  @Post('swap-ingredient/apply')
  applyIngredientSwap(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.plans.applyIngredientSwap(user.id, locale, dto);
  }
}
