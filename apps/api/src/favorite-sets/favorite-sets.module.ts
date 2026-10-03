// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { MealPlansModule } from '../meal-plans/meal-plans.module.js';
import { FavoriteSetsController } from './favorite-sets.controller.js';
import { FavoriteSetsService } from './favorite-sets.service.js';

@Module({
  imports: [MealPlansModule],
  controllers: [FavoriteSetsController],
  providers: [FavoriteSetsService],
})
export class FavoriteSetsModule {}
