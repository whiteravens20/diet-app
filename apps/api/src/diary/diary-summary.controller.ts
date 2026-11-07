// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Expenditure, ExpenditureRequest, WeekSummary, WeekSummaryQuery } from '@diet-app/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Answers } from '../common/answers.decorator.js';
import { ClientDate } from '../common/client-date.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DiarySummaryService } from './diary-summary.service.js';

@Controller('diary')
@UseGuards(JwtAuthGuard)
export class DiarySummaryController {
  constructor(private readonly summary: DiarySummaryService) {}

  /**
   * The week of a profile in sum: the seven days that end with `?to=`, or with
   * yesterday by the client's day. What the days with an entry or an eaten
   * meal ate on average against what they aimed at, how many came within a
   * tenth of it, and where the weights of the last 28 days lead.
   */
  @Get('week')
  @Answers(WeekSummary)
  week(
    @CurrentUser() user: RequestUser,
    @ClientDate() today: string | null,
    @Query(new ZodValidationPipe(WeekSummaryQuery)) query: WeekSummaryQuery,
  ) {
    return this.summary.week(user.id, query.profileId, query.to, today);
  }

  /**
   * What the diary and the weights of the three weeks before today say a
   * profile really uses, worked out again once a week, and the correction of
   * its target that comes of it: proposed, never applied unasked.
   */
  @Get('expenditure')
  @Answers(Expenditure)
  expenditure(
    @CurrentUser() user: RequestUser,
    @ClientDate() today: string | null,
    @Query(new ZodValidationPipe(ExpenditureRequest)) query: ExpenditureRequest,
  ) {
    return this.summary.expenditure(user.id, query.profileId, today);
  }

  /** Take the correction proposed; refused with `EXPENDITURE_NOTHING_PROPOSED` where none is. */
  @Post('expenditure/accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(Expenditure)
  accept(
    @CurrentUser() user: RequestUser,
    @ClientDate() today: string | null,
    @Body(new ZodValidationPipe(ExpenditureRequest)) dto: ExpenditureRequest,
  ) {
    return this.summary.accept(user.id, dto.profileId, today);
  }

  /** Put the proposal off for two weeks. */
  @Post('expenditure/later')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(Expenditure)
  later(
    @CurrentUser() user: RequestUser,
    @ClientDate() today: string | null,
    @Body(new ZodValidationPipe(ExpenditureRequest)) dto: ExpenditureRequest,
  ) {
    return this.summary.later(user.id, dto.profileId, today);
  }

  /** Take a kept correction away: the formula's target again, and no proposal for two weeks. */
  @Post('expenditure/drop')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(Expenditure)
  drop(
    @CurrentUser() user: RequestUser,
    @ClientDate() today: string | null,
    @Body(new ZodValidationPipe(ExpenditureRequest)) dto: ExpenditureRequest,
  ) {
    return this.summary.drop(user.id, dto.profileId, today);
  }
}
