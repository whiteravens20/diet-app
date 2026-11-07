// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { WeekSummary, WeekSummaryQuery } from '@diet-app/shared';
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
}
