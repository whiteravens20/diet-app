// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateWeightEntryRequest,
  WeightDay,
  WeightDaysQuery,
  WeightEntry,
  WeightListQuery,
} from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { IdempotencyKey } from '../common/idempotency-key.decorator.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { WeightsService } from './weights.service.js';

@Controller('weights')
@UseGuards(JwtAuthGuard)
export class WeightsController {
  constructor(private readonly weights: WeightsService) {}

  /**
   * The weights noted for a profile, the newest first. `?since=` leaves out
   * what is older than a moment: a chart of three months asks for three
   * months.
   */
  @Get()
  @AnswersListOf(WeightEntry)
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(WeightListQuery)) query: WeightListQuery,
  ) {
    return this.weights.list(
      user.id,
      query.profileId,
      query.since ? new Date(query.since) : undefined,
    );
  }

  /**
   * The weights of a profile by day, as a chart draws them: each day's last
   * entry and the mean of the seven days that end with it, the oldest day
   * first. A day is one of the time zone the client names (`?timeZone=`);
   * `?since=` leaves out the days before the one it falls on.
   */
  @Get('days')
  @AnswersListOf(WeightDay)
  days(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(WeightDaysQuery)) query: WeightDaysQuery,
  ) {
    return this.weights.days(
      user.id,
      query.profileId,
      query.timeZone,
      query.since ? new Date(query.since) : undefined,
    );
  }

  /**
   * Note a weight of a profile for a day. Sent again with the same
   * `Idempotency-Key` within a week, it is answered with the entry the first
   * request noted and notes nothing.
   */
  @Post()
  @Answers(WeightEntry)
  create(
    @CurrentUser() user: RequestUser,
    @IdempotencyKey() key: string | null,
    @Body(new ZodValidationPipe(CreateWeightEntryRequest)) dto: CreateWeightEntryRequest,
  ) {
    const { profileId, ...body } = dto;
    return this.weights.create(user.id, profileId, body, key);
  }

  /** Remove a noted weight. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.weights.remove(user.id, id);
  }
}
