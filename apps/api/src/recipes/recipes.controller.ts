import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { Locale } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RecipesService } from './recipes.service.js';

@Controller('recipes')
@UseGuards(JwtAuthGuard)
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

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
  ) {
    return this.recipes.search(user.id, locale, {
      search,
      dietType,
      mealType,
      maxCalories: maxCalories ? Number(maxCalories) : undefined,
      maxPrepMinutes: maxPrepMinutes ? Number(maxPrepMinutes) : undefined,
      difficulty,
    });
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @RequestLocale() locale: Locale, @Param('id') id: string) {
    return this.recipes.get(user.id, locale, id);
  }
}
