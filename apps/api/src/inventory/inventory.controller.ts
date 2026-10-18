// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InventoryItem, PatchInventoryItem, UpsertInventoryItemRequest, type Locale } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { InventoryService } from './inventory.service.js';

@Controller('inventory')
@UseGuards(JwtAuthGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /** What a profile's pantry holds, by aisle and by name as the request's language sorts names. */
  @Get()
  @AnswersListOf(InventoryItem)
  list(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query('profileId', requiredUuid) profileId: string,
  ) {
    return this.inventory.list(user.id, locale, profileId);
  }

  /** Put something into the pantry: added to the row of that ingredient and unit, or a new row. */
  @Post()
  @Answers(InventoryItem)
  upsert(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(UpsertInventoryItemRequest)) dto: UpsertInventoryItemRequest,
  ) {
    const { profileId, ...body } = dto;
    return this.inventory.upsert(user.id, locale, profileId, body);
  }

  /** Change a row of the pantry. */
  @Patch(':id')
  @Answers(InventoryItem)
  patch(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(PatchInventoryItem)) dto: PatchInventoryItem,
  ) {
    return this.inventory.patch(user.id, locale, id, dto);
  }

  /** Take a row out of the pantry. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.inventory.remove(user.id, id);
  }
}
