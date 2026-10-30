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
import { Throttle } from '@nestjs/throttler';
import {
  CopyDiaryDayRequest,
  CreateDiaryEntryRequest,
  DiaryCopyResult,
  DiaryDay,
  DiaryDayQuery,
  DiaryEntry,
  UpdateDiaryEntryRequest,
  type Locale,
} from '@diet-app/shared';
import { Answers } from '../common/answers.decorator.js';
import { ClientDate } from '../common/client-date.decorator.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { IdempotencyKey } from '../common/idempotency-key.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { DiaryService } from './diary.service.js';

@Controller('diary')
@UseGuards(JwtAuthGuard)
export class DiaryController {
  constructor(private readonly diary: DiaryService) {}

  /**
   * A day of a profile's diary: the entries written for it, the meals of the
   * plan that holds it (the one made last where several do), what was eaten
   * against the day's target, and where the plan's day stands with the
   * entries counted as eaten.
   */
  @Get('day')
  @Answers(DiaryDay)
  day(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query(new ZodValidationPipe(DiaryDayQuery)) query: DiaryDayQuery,
  ) {
    return this.diary.day(user.id, locale, query.profileId, query.date);
  }

  /**
   * Write an entry for a day of today or before it, by the client's day
   * (`X-Client-Date`): a recipe in servings, an ingredient in an amount, or a
   * meal of one's own by its figures, those of its macronutrients left out
   * estimated from its energy. Its figures are worked out now and kept. Sent
   * again with the same `Idempotency-Key` within a week, it is answered with
   * the entry the first request wrote and writes nothing.
   */
  @Post('entries')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(DiaryEntry)
  create(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @IdempotencyKey() key: string | null,
    @ClientDate() today: string | null,
    @Body(new ZodValidationPipe(CreateDiaryEntryRequest)) dto: CreateDiaryEntryRequest,
  ) {
    return this.diary.create(user.id, locale, dto, key, today);
  }

  /** Change an entry: the meal it is under, or how much of it there was, which changes its figures in proportion. */
  @Patch('entries/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(DiaryEntry)
  update(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(UpdateDiaryEntryRequest)) dto: UpdateDiaryEntryRequest,
  ) {
    return this.diary.update(user.id, locale, id, dto);
  }

  /** Remove an entry. */
  @Delete('entries/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.diary.remove(user.id, id);
  }

  /**
   * Copy what was eaten on one day into another of today or before it: the
   * entries of the day, and the meals its plan marked as eaten, which come in
   * as entries. Nothing is copied where the day would then hold more than the
   * most. Sent again with the same `Idempotency-Key` within a week, it is
   * answered with the day as it is now and copies nothing.
   */
  @Post('copy')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(DiaryCopyResult)
  copy(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @IdempotencyKey() key: string | null,
    @ClientDate() today: string | null,
    @Body(new ZodValidationPipe(CopyDiaryDayRequest)) dto: CopyDiaryDayRequest,
  ) {
    return this.diary.copy(user.id, locale, dto, key, today);
  }
}
