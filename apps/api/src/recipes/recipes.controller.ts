import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RecipesService } from './recipes.service.js';

@Controller('recipes')
@UseGuards(JwtAuthGuard)
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get()
  search(
    @CurrentUser() user: RequestUser,
    @Query('search') search?: string,
    @Query('dietType') dietType?: string,
    @Query('mealType') mealType?: string,
    @Query('maxCalories') maxCalories?: string,
    @Query('maxPrepMinutes') maxPrepMinutes?: string,
    @Query('difficulty') difficulty?: string,
  ) {
    return this.recipes.search(user.id, {
      search,
      dietType,
      mealType,
      maxCalories: maxCalories ? Number(maxCalories) : undefined,
      maxPrepMinutes: maxPrepMinutes ? Number(maxPrepMinutes) : undefined,
      difficulty,
    });
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.recipes.get(user.id, id);
  }
}
