// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { GenerateShoppingListRequest, type Locale, UpdateShoppingItemRequest, WeighRequest } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ListProposalsService } from './list-proposals.service.js';
import { ShoppingListsService } from './shopping-lists.service.js';

@Controller('shopping-lists')
@UseGuards(JwtAuthGuard)
export class ShoppingListsController {
  constructor(
    private readonly lists: ShoppingListsService,
    private readonly proposals: ListProposalsService,
  ) {}

  @Post('generate')
  generate(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(GenerateShoppingListRequest)) dto: GenerateShoppingListRequest,
  ) {
    return this.lists.generate(user.id, locale, dto);
  }

  /** Lists for one plan, newest first — drives the shopping-list page. */
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query('planId', requiredUuid) planId: string,
  ) {
    return this.lists.listForPlan(user.id, locale, planId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
  ) {
    return this.lists.get(user.id, locale, id);
  }

  /**
   * What the list could do without: rows that one ingredient could stand
   * for, and packs that will be left over. The engine works them out, and a
   * model puts them in order and says a sentence of each when the request
   * asks for one. Nothing is written. Every meal of the list's days may be
   * looked at for it, so the limit is that of making a plan.
   */
  @Post(':id/proposals')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  propose(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(WeighRequest)) dto: WeighRequest,
  ) {
    return this.proposals.propose(user.id, locale, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.lists.remove(user.id, id);
  }

  @Patch(':id/items/:itemId')
  updateItem(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('itemId', requiredUuid) itemId: string,
    @Body(new ZodValidationPipe(UpdateShoppingItemRequest)) dto: UpdateShoppingItemRequest,
  ) {
    return this.lists.updateItem(user.id, locale, id, itemId, dto);
  }
}
