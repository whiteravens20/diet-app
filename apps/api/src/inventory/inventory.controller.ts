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
import {
  FreezeInventoryItem,
  InventoryItem,
  PatchInventoryItem,
  UpsertInventoryItemRequest,
  type Locale,
} from '@diet-app/shared';
import { ClientDate } from '../common/client-date.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { IdempotencyKey } from '../common/idempotency-key.decorator.js';
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

  /**
   * Put something into the pantry: added to the row of that ingredient and unit, or a new row; what is counted, to its row in pieces. Sent again with the same `Idempotency-Key` within a week, it is answered with that row as it is now and adds nothing.
   */
  @Post()
  @Answers(InventoryItem)
  upsert(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @IdempotencyKey() key: string | null,
    @Body(new ZodValidationPipe(UpsertInventoryItemRequest)) dto: UpsertInventoryItemRequest,
  ) {
    const { profileId, ...body } = dto;
    return this.inventory.upsert(user.id, locale, profileId, body, key);
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

  /**
   * "Zamroź": a fresh row goes into the freezer, split into `portions` packages of their own as evenly as its unit
   * allows, each dated 30 days from the client's day; none adds to a package there is. Answered with the profile's
   * pantry as it is then. Sent again with the same `Idempotency-Key` within a week, it is answered with the pantry as
   * it is now.
   */
  @Post(':id/freeze')
  @HttpCode(200)
  @AnswersListOf(InventoryItem)
  freeze(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @IdempotencyKey() key: string | null,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(FreezeInventoryItem)) dto: FreezeInventoryItem,
    @ClientDate() today: string | null,
  ) {
    return this.inventory.freeze(user.id, locale, id, dto, today, key);
  }

  /** Take a row out of the pantry. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.inventory.remove(user.id, id);
  }
}
