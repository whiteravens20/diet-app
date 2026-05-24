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
import { GeneratePlanRequest, SwapIngredientRequest, SwapMealRequest } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { MealPlansService } from './meal-plans.service.js';

@Controller('meal-plans')
@UseGuards(JwtAuthGuard)
export class MealPlansController {
  constructor(private readonly plans: MealPlansService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query('profileId') profileId: string) {
    return this.plans.list(user.id, profileId);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.plans.get(user.id, id);
  }

  /** Plan generation is rate-limited tighter — it is compute-heavy. */
  @Post('generate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  generate(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(GeneratePlanRequest)) dto: GeneratePlanRequest,
  ) {
    return this.plans.generate(user.id, dto);
  }

  /** Re-run the optimiser for a whole plan, in place. */
  @Post(':id/regenerate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  regenerate(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.plans.regenerate(user.id, id);
  }

  /** Re-roll the meals of a single day. */
  @Post(':id/days/:dayId/regenerate')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  regenerateDay(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('dayId') dayId: string,
  ) {
    return this.plans.regenerateDay(user.id, id, dayId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.plans.remove(user.id, id);
  }

  @Post('swap-meal')
  swapMeal(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(SwapMealRequest)) dto: SwapMealRequest,
  ) {
    return this.plans.swapMeal(user.id, dto);
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
    @Body(new ZodValidationPipe(SwapIngredientRequest)) dto: SwapIngredientRequest,
  ) {
    return this.plans.applyIngredientSwap(user.id, dto);
  }
}
