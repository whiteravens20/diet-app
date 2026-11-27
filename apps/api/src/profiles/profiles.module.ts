// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { MealPlansModule } from '../meal-plans/meal-plans.module.js';
import { ProfileTargetsFill } from './profile-targets-fill.js';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';

@Module({
  // A change of what a profile may be given goes through its plans made together (`refreshJointPlans`).
  imports: [MealPlansModule],
  controllers: [ProfilesController],
  // What every profile from before the rows of its target aims at, written down at the start.
  providers: [ProfilesService, ProfileTargetsFill],
})
export class ProfilesModule {}
