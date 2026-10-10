// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PersonalRecipesModule } from '../recipes/personal-recipes.module.js';
import { RecipesModule } from '../recipes/recipes.module.js';
import { MealPlansController } from './meal-plans.controller.js';
import { MealPlansService } from './meal-plans.service.js';

@Module({
  imports: [RecipesModule, AiModule, PersonalRecipesModule],
  controllers: [MealPlansController],
  providers: [MealPlansService],
  exports: [MealPlansService],
})
export class MealPlansModule {}
