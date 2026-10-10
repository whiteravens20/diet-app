// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PersonalRecipesService } from './personal-recipes.service.js';

/**
 * A module of its own, so that the plan service and the recipe service can
 * both store personal recipes without depending on each other.
 */
@Module({
  imports: [PrismaModule],
  providers: [PersonalRecipesService],
  exports: [PersonalRecipesService],
})
export class PersonalRecipesModule {}
