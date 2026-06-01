import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { DedupModule } from '../admin/drafts/dedup.module.js';
import { RecipesModule } from '../recipes/recipes.module.js';
import { MealPlansController } from './meal-plans.controller.js';
import { MealPlansService } from './meal-plans.service.js';

@Module({
  imports: [RecipesModule, AiModule, DedupModule],
  controllers: [MealPlansController],
  providers: [MealPlansService],
  exports: [MealPlansService],
})
export class MealPlansModule {}
