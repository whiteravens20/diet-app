// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { BasicAuthGuard } from '../basic-auth.guard.js';
import { DedupModule } from './dedup.module.js';
import { DraftsController } from './drafts.controller.js';
import { IngredientNamerRunner } from './ingredient-namer.runner.js';
import { RecipeGeneratorRunner } from './recipe-generator.runner.js';

/**
 * Curation queue module. Wires the ingredient-name pipeline, the
 * recipe-generator runner, the ship runners, and the AI_USER promote path
 * (handler lives in the controller, dedup helper comes from DedupModule and is
 * shared with recipes / meal-plans). The controller stays the umbrella for
 * every /api/admin/drafts/* endpoint.
 */
@Module({
  imports: [PrismaModule, AiModule, DedupModule],
  controllers: [DraftsController],
  providers: [BasicAuthGuard, IngredientNamerRunner, RecipeGeneratorRunner],
})
export class DraftsModule {}
