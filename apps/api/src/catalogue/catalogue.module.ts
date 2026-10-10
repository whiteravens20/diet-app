// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { CatalogueCoverageService } from './catalogue-coverage.service.js';

/** What the recipe catalogue holds, for the parts of the API that report on it. */
@Module({
  providers: [CatalogueCoverageService],
  exports: [CatalogueCoverageService],
})
export class CatalogueModule {}
