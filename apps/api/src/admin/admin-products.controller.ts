// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminProducts } from '@diet-app/shared';
import { Answers } from '../common/answers.decorator.js';
import { ProductImport } from '../products/product-import.js';
import { AdminSessionGuard } from './admin-session.guard.js';

/** What the instance holds of products with a barcode, and how it gets them. */
@Controller('admin/products')
@UseGuards(AdminSessionGuard)
export class AdminProductsController {
  constructor(private readonly products: ProductImport) {}

  /** The settings of lookups and of the import, what the instance holds, and how the last import went. */
  @Get()
  @Answers(AdminProducts)
  overview(): Promise<AdminProducts> {
    return this.products.overview();
  }

  /**
   * Ask for an import now, instead of at night: the worker begins it within a
   * minute. Refused while one runs, and within 24 hours of the last start
   * unless the settings name other countries now.
   */
  @Post('import')
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async askForImport(): Promise<void> {
    await this.products.ask();
  }
}
