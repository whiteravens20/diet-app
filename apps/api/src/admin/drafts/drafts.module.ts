import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { BasicAuthGuard } from '../basic-auth.guard.js';
import { DraftsController } from './drafts.controller.js';
import { IngredientNamerRunner } from './ingredient-namer.runner.js';
import { RecipeGeneratorRunner } from './recipe-generator.runner.js';

/**
 * Curation queue module. Phase C wires the ingredient-name pipeline;
 * Phase D adds the recipe-generator runner; Phase E adds the ship runners.
 * The controller stays the umbrella for every /api/admin/drafts/* endpoint.
 */
@Module({
  imports: [PrismaModule, AiModule],
  controllers: [DraftsController],
  providers: [BasicAuthGuard, IngredientNamerRunner, RecipeGeneratorRunner],
})
export class DraftsModule {}
