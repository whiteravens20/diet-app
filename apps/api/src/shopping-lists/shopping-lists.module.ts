// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { MealPlansModule } from '../meal-plans/meal-plans.module.js';
import { ListProposalsService } from './list-proposals.service.js';
import { ShoppingListsController } from './shopping-lists.controller.js';
import { ShoppingListsService } from './shopping-lists.service.js';

@Module({
  imports: [AiModule, MealPlansModule],
  controllers: [ShoppingListsController],
  providers: [ShoppingListsService, ListProposalsService],
})
export class ShoppingListsModule {}
