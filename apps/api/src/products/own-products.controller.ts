// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OwnProduct, OwnProductBody, OwnProducts, ProductAdditions } from '@diet-app/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Answers } from '../common/answers.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OwnProductsService } from './own-products.service.js';

/** What an account writes of products for itself, and sends to the instance's base. */
@Controller('products')
@UseGuards(JwtAuthGuard)
export class OwnProductsController {
  constructor(private readonly own: OwnProductsService) {}

  /** The account's own products, whatever became of them. */
  @Get('own')
  @Answers(OwnProducts)
  list(@CurrentUser() user: RequestUser) {
    return this.own.list(user.id);
  }

  /** Write a product: 500 held, 50 written or changed in 24 hours, and a code the base knows is refused. */
  @Post('own')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(OwnProduct)
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(OwnProductBody)) body: OwnProductBody,
  ) {
    return this.own.create(user.id, body);
  }

  /** Change a product: one waiting for review leaves the queue, and has to be sent again. */
  @Patch('own/:id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(OwnProduct)
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(OwnProductBody)) body: OwnProductBody,
  ) {
    return this.own.update(user.id, id, body);
  }

  /** Delete a product: what the diary holds of it keeps its figures. */
  @Delete('own/:id')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.own.remove(user.id, id);
  }

  /** Send a product with a code and all its figures to the instance's reviewers: 10 in 24 hours. */
  @Post('own/:id/send')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Answers(OwnProduct)
  send(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    return this.own.send(user.id, id);
  }

  /** Take a product back out of the queue. */
  @Post('own/:id/withdraw')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(OwnProduct)
  withdraw(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    return this.own.withdraw(user.id, id);
  }

  /** What people added to the instance's base, without who added it, as a file. */
  @Get('additions')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Content-Disposition', 'attachment; filename="products-added.json"')
  @Answers(ProductAdditions)
  additions() {
    return this.own.additions();
  }
}
