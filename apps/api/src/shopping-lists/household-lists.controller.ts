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
  UseGuards,
} from '@nestjs/common';
import {
  GenerateHouseholdListRequest,
  HouseholdList,
  UpdateShoppingItemRequest,
  type Locale,
} from '@diet-app/shared';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { HouseholdListsService } from './household-lists.service.js';

/** One shopping list for plans of several profiles of the account: each plan's list is a part of it. */
@Controller('household-lists')
@UseGuards(JwtAuthGuard)
export class HouseholdListsController {
  constructor(private readonly households: HouseholdListsService) {}

  /**
   * Make a household list of plans of several profiles, one a profile, for
   * the same days. Each plan's lists that share a day with its part are
   * replaced, as by a list of its own.
   */
  @Post()
  @Answers(HouseholdList)
  generate(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(GenerateHouseholdListRequest)) dto: GenerateHouseholdListRequest,
  ) {
    return this.households.generate(user.id, locale, dto);
  }

  /** The household lists of the account, the newest first. */
  @Get()
  @AnswersListOf(HouseholdList)
  list(@CurrentUser() user: RequestUser, @RequestLocale() locale: Locale) {
    return this.households.list(user.id, locale);
  }

  /** One household list. */
  @Get(':id')
  @Answers(HouseholdList)
  get(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
  ) {
    return this.households.get(user.id, locale, id);
  }

  /** Delete a household list and its parts. What was obtained for days still ahead goes into each profile's pantry. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.households.remove(user.id, id);
  }

  /** Change a row of a household list, and with it the row of each part: what the household holds, what is at home, or the tick. */
  @Patch(':id/items/:itemId')
  @Answers(HouseholdList)
  updateItem(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Param('itemId', requiredUuid) itemId: string,
    @Body(new ZodValidationPipe(UpdateShoppingItemRequest)) dto: UpdateShoppingItemRequest,
  ) {
    return this.households.updateItem(user.id, locale, id, itemId, dto);
  }
}
