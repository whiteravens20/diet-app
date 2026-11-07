// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AddWaterRequest, WaterDay, WaterDayQuery } from '@diet-app/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Answers } from '../common/answers.decorator.js';
import { ClientDate } from '../common/client-date.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { IdempotencyKey } from '../common/idempotency-key.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WaterService } from './water.service.js';

@Controller('water')
@UseGuards(JwtAuthGuard)
export class WaterController {
  constructor(private readonly water: WaterService) {}

  /** The water of a day of a profile's calendar (`?day=`): what was drunk in all, against its target. */
  @Get()
  @Answers(WaterDay)
  day(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(WaterDayQuery)) query: WaterDayQuery,
  ) {
    return this.water.day(user.id, query.profileId, query.day);
  }

  /**
   * Water drunk on a day of today or at most a year before it, answered with
   * the day as it is then. A day holds at most 50 entries. Sent again with the
   * same `Idempotency-Key` within a week, it writes nothing and is answered
   * with the day as it is now.
   */
  @Post()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(WaterDay)
  add(
    @CurrentUser() user: RequestUser,
    @IdempotencyKey() key: string | null,
    @ClientDate() today: string | null,
    @Body(new ZodValidationPipe(AddWaterRequest)) dto: AddWaterRequest,
  ) {
    return this.water.add(user.id, dto, key, today);
  }

  /** Remove an entry written by mistake, answered with its day as it is then. */
  @Delete(':id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(WaterDay)
  remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    return this.water.remove(user.id, id);
  }
}
