// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PersonalRecipesModule } from '../recipes/personal-recipes.module.js';
import { RecipesModule } from '../recipes/recipes.module.js';
import { DayVariationsService } from './day-variations.service.js';
import { IngredientSwapService } from './ingredient-swap.service.js';
import { MealPlansController } from './meal-plans.controller.js';
import { MealPlansService } from './meal-plans.service.js';
import { MealSwapService } from './meal-swap.service.js';
import { PlanCalendarService } from './plan-calendar.service.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { PlanOverviewService } from './plan-overview.service.js';
import { UseUpService } from './use-up.service.js';

@Module({
  imports: [RecipesModule, AiModule, PersonalRecipesModule],
  controllers: [MealPlansController],
  providers: [MealPlansService, PlanGenerationService, IngredientSwapService, MealSwapService, PlanOverviewService, PlanCalendarService, UseUpService, DayVariationsService],
  exports: [MealPlansService, PlanGenerationService],
})
export class MealPlansModule {}
