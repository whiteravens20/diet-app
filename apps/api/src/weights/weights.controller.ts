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
import { CreateWeightEntryRequest, WeightEntry, WeightListQuery } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
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

  /** Note a weight of a profile for a day. */
  @Post()
  @Answers(WeightEntry)
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(CreateWeightEntryRequest)) dto: CreateWeightEntryRequest,
  ) {
    const { profileId, ...body } = dto;
    return this.weights.create(user.id, profileId, body);
  }

  /** Remove a noted weight. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.weights.remove(user.id, id);
  }
}
