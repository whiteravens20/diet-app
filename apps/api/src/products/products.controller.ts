// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Product, ProductSearchQuery, ProductSearchResult } from '@diet-app/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Answers } from '../common/answers.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { requiredProductCode, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ProductsService } from './products.service.js';

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  /**
   * Search what the instance holds by words of a name or a brand: at most 20
   * products that can be written into a diary, those people scan most first. A
   * search never leaves the instance.
   */
  @Get()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(ProductSearchResult)
  search(@Query(new ZodValidationPipe(ProductSearchQuery)) query: ProductSearchQuery) {
    return this.products.search(query.search);
  }

  /**
   * The product of an EAN or UPC code. A code the instance does not hold is
   * asked of Open Food Facts, in the instance's name, where the instance does
   * that: an account asks at most 5 such codes a minute and 100 in 24 hours, the
   * instance at most 12 a minute, and a code Open Food Facts does not know is
   * not asked again for 7 days.
   */
  @Get('code/:code')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(Product)
  byCode(@CurrentUser() user: RequestUser, @Param('code', requiredProductCode) code: string) {
    return this.products.byCode(user.id, code);
  }
}
