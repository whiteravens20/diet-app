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
  InventoryPortion,
  PatchInventoryItem,
  StillGoodRequest,
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
   * Put something into the pantry: added to the row of that ingredient and unit, or a new row; what is counted, to its row in pieces. An ingredient the catalogue retired is refused as one that does not exist (404 `INGREDIENT_NOT_FOUND`) unless the pantry still holds it. Sent again with the same `Idempotency-Key` within a week, it is answered with that row as it is now and adds nothing.
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

  /** Change a row of the pantry. Lowered, the rows of the profile's lists not ticked count on no more than the pantry holds. */
  @Patch(':id')
  @Answers(InventoryItem)
  patch(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(PatchInventoryItem)) dto: PatchInventoryItem,
    @ClientDate() today: string | null,
  ) {
    return this.inventory.patch(user.id, locale, id, dto, today);
  }

  /**
   * The size to freeze a row in before "Zamroź": the most the profile's plans that have a day after today eat of its
   * food on a day and the next, from tomorrow on, with the other plan of a joint plan's kitchen, a package coming out of
   * the freezer only whole; in the row's unit where it converts, null where none of them takes the food from packs.
   */
  @Get(':id/portion')
  @Answers(InventoryPortion)
  portion(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @ClientDate() today: string | null,
  ) {
    return this.inventory.portion(user.id, id, today ?? new Date().toISOString().slice(0, 10));
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

  /**
   * "Nadal dobre": fresh stock past its best-before day is still good, with a new day or without one; either way it
   * counts at home again, without one until its day or amount changes. 400 `BEST_BEFORE_PAST` for a new day before the
   * client's, 409 `FROZEN_KEEPS_ITS_DAY` for a package of the freezer.
   */
  @Post(':id/still-good')
  @HttpCode(200)
  @Answers(InventoryItem)
  stillGood(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(StillGoodRequest)) dto: StillGoodRequest,
    @ClientDate() today: string | null,
  ) {
    return this.inventory.stillGood(user.id, locale, id, dto, today);
  }

  /**
   * Take a row out of the pantry: the food is not at home. The profile's shopping lists follow: a row that took of it
   * counts it at home no more (it unticks where it no longer meets the need), a row not ticked counts on no more than
   * the pantry holds, and nothing of it comes back to the pantry when a list is removed.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @ClientDate() today: string | null,
  ) {
    await this.inventory.remove(user.id, id, today);
  }
}
