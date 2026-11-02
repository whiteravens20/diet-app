// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AcceptedProducts,
  AcceptedProductsQuery,
  AcceptProductRequest,
  AdminProducts,
  ProductQueue,
  RejectProductRequest,
  WithdrawProductRequest,
} from '@diet-app/shared';
import { Answers } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ProductImport } from '../products/product-import.js';
import { ProductReviewService } from '../products/product-review.service.js';
import { AdminSessionGuard } from './admin-session.guard.js';

/** What the instance holds of products with a barcode, and how it gets them. */
@Controller('admin/products')
@UseGuards(AdminSessionGuard)
export class AdminProductsController {
  constructor(
    private readonly products: ProductImport,
    private readonly review: ProductReviewService,
  ) {}

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

  /** The products accounts sent to the base, the longest waiting first. */
  @Get('queue')
  @Answers(ProductQueue)
  queue() {
    return this.review.queue();
  }

  /** Take a product into the base, as it was read. */
  @Post('queue/:id/accept')
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async accept(
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(AcceptProductRequest)) body: AcceptProductRequest,
  ): Promise<void> {
    await this.review.accept(id, body.updatedAt, 'admin');
  }

  /** Turn a product down, with what its author is told. */
  @Post('queue/:id/reject')
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async reject(
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(RejectProductRequest)) body: RejectProductRequest,
  ): Promise<void> {
    await this.review.reject(id, body.updatedAt, body.reason);
  }

  /** What the instance accepted, the latest first. */
  @Get('accepted')
  @Answers(AcceptedProducts)
  accepted(@Query(new ZodValidationPipe(AcceptedProductsQuery)) query: AcceptedProductsQuery) {
    return this.review.accepted(query.page);
  }

  /** Withdraw an accepted product, with what its author is told. */
  @Post('accepted/:id/withdraw')
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async withdraw(
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(WithdrawProductRequest)) body: WithdrawProductRequest,
  ): Promise<void> {
    await this.review.withdraw(id, body.reason);
  }
}
