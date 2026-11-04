// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OwnProductsController } from './own-products.controller.js';
import { OwnProductsService } from './own-products.service.js';
import { ProductSourceModule } from './product-source.module.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [ProductSourceModule, NotificationsModule],
  controllers: [ProductsController, OwnProductsController],
  providers: [ProductsService, OwnProductsService],
})
export class ProductsModule {}
