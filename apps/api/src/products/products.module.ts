// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { ProductSourceModule } from './product-source.module.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [ProductSourceModule],
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
