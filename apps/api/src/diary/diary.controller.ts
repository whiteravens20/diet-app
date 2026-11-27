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
  DiaryDay,
  DiaryDayQuery,
  EatenPantry,
  UpdateDiaryEntryRequest,
  type Locale,
  WrittenDiaryCopy,
  WrittenDiaryEntry,
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
   * against the day's target, where the plan's day stands with the entries
   * counted as eaten, and whether sizing it again would give a meal another
   * portion.
   */
  @Get('day')
  @Answers(DiaryDay)
  day(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query(new ZodValidationPipe(DiaryDayQuery)) query: DiaryDayQuery,
    @ClientDate() today: string | null,
  ) {
    return this.diary.day(user.id, locale, query.profileId, query.date, today);
  }

  /**
   * Write an entry for a day of today or at most a year before it, by the
   * client's day (`X-Client-Date`): a recipe in servings, an ingredient in an
   * amount, a product in grams or millilitres, or a meal of one's own by its
   * figures. What a meal of one's own leaves out, or a product's label lacks, is
   * estimated from its energy. Its figures are worked out now and kept. Sent again with the same `Idempotency-Key` within a week, it is
   * answered with the entry the first request wrote and writes nothing. An entry of today sizes the day of the plan the
   * diary shows again, as a meal of one's own added to the plan does, and says how (`WrittenDiaryEntry.planChange`).
   */
  @Post('entries')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(WrittenDiaryEntry)
  create(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @IdempotencyKey() key: string | null,
    @ClientDate() today: string | null,
    @Body(new ZodValidationPipe(CreateDiaryEntryRequest)) dto: CreateDiaryEntryRequest,
  ) {
    return this.diary.create(user.id, locale, dto, key, today);
  }

  /**
   * Change an entry: the meal it is under, or how much of it there was, which
   * changes its figures in proportion. An entry of a product can be moved to a
   * product of the reader's own, whose label then gives its figures. A change of
   * an entry of today sizes the day of the plan the diary shows again, and says
   * how (`WrittenDiaryEntry.planChange`).
   */
  @Patch('entries/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(WrittenDiaryEntry)
  update(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @Body(new ZodValidationPipe(UpdateDiaryEntryRequest)) dto: UpdateDiaryEntryRequest,
    @ClientDate() today: string | null,
  ) {
    return this.diary.update(user.id, locale, id, dto, today);
  }

  /** Remove an entry; the day of the plan the diary shows follows, where it is today, as it does a new entry. */
  @Delete('entries/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
    @ClientDate() today: string | null,
  ) {
    await this.diary.remove(user.id, id, today);
  }

  /**
   * What an entry of an ingredient or a recipe takes off the pantry on a day no shopping list covers, offered while
   * nothing was taken, and what it took ("Zdejmij ze spiżarni to, co zjedzono"). Nothing changes by itself.
   */
  @Get('entries/:id/pantry')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Answers(EatenPantry)
  entryPantry(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @ClientDate() today: string | null,
  ) {
    return this.diary.entryPantry(user.id, locale, id, today);
  }

  /** Take what the entry ate off the pantry, as offered: once, until it is given back. */
  @Post('entries/:id/pantry-take')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(EatenPantry)
  takeEntryPantry(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @ClientDate() today: string | null,
  ) {
    return this.diary.takeEntryPantry(user.id, locale, id, today);
  }

  /** Give back to the pantry what the entry took off it ("Oddaj do spiżarni"). */
  @Post('entries/:id/pantry-return')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Answers(EatenPantry)
  returnEntryPantry(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id', requiredUuid) id: string,
    @ClientDate() today: string | null,
  ) {
    return this.diary.returnEntryPantry(user.id, locale, id, today);
  }

  /**
   * Copy what was eaten on one day into another of today or at most a year
   * before it: the entries of the day, and the meals its plan marked as eaten,
   * which come in as entries. Nothing is copied where the day would then hold
   * more than the most. Sent again with the same `Idempotency-Key` within a
   * week, it is answered with the day as it is now and copies nothing. A copy
   * into today sizes the day of the plan the diary shows again, and says how
   * (`WrittenDiaryCopy.planChange`).
   */
  @Post('copy')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Answers(WrittenDiaryCopy)
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
