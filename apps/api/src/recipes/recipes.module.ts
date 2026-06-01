import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { DedupModule } from '../admin/drafts/dedup.module.js';
import { AiRecipeDraftService } from './ai-recipe-draft.service.js';
import { RecipesController } from './recipes.controller.js';
import { RecipesService } from './recipes.service.js';

@Module({
  imports: [AiModule, DedupModule],
  controllers: [RecipesController],
  providers: [RecipesService, AiRecipeDraftService],
  exports: [RecipesService],
})
export class RecipesModule {}
