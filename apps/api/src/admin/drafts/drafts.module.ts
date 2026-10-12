// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { CatalogueModule } from '../../catalogue/catalogue.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AdminSessionGuard } from '../admin-session.guard.js';
import { AdminModelService } from './admin-model.service.js';
import { DraftService } from './draft.service.js';
import { DraftsController } from './drafts.controller.js';
import { IngredientNamerRunner } from './ingredient-namer.runner.js';
import { RecipeGeneratorRunner } from './recipe-generator.runner.js';
import { TranslationRunner } from './translation.runner.js';

/**
 * Curation queue module. Wires the ingredient-name pipeline, the
 * recipe-generator runner, the run that fills a missing language, the ship
 * runners, and the promotion of a draft
 * made from personal recipes (handler lives in the controller). The controller
 * stays the umbrella for every /api/admin/drafts/* endpoint. `DraftService`
 * holds the queue's own rules and is what the reviewers' routes use too.
 */
@Module({
  imports: [PrismaModule, AiModule, CatalogueModule],
  controllers: [DraftsController],
  providers: [AdminSessionGuard, IngredientNamerRunner, RecipeGeneratorRunner, TranslationRunner, AdminModelService, DraftService],
  exports: [DraftService],
})
export class DraftsModule {}
