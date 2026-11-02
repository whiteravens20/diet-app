// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OpenFoodFacts } from './open-food-facts.js';
import { ProductImport } from './product-import.js';

/** Open Food Facts and the import from it: for the worker that runs it, and for the panel that shows it. */
@Module({
  imports: [PrismaModule],
  providers: [OpenFoodFacts, ProductImport],
  exports: [OpenFoodFacts, ProductImport],
})
export class ProductSourceModule {}
