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
import { CreateWeightEntryRequest, WeightListQuery } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { WeightsService } from './weights.service.js';

@Controller('weights')
@UseGuards(JwtAuthGuard)
export class WeightsController {
  constructor(private readonly weights: WeightsService) {}

  /**
   * `?since=ISO` caps the result to entries newer than the given date —
   * the dashboard sends `now() - 90d` so we don't transfer years of
   * history every page load.
   */
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(WeightListQuery)) query: WeightListQuery,
  ) {
    return this.weights.list(user.id, query.profileId, query.since ? new Date(query.since) : undefined);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(CreateWeightEntryRequest)) dto: CreateWeightEntryRequest,
  ) {
    const { profileId, ...body } = dto;
    return this.weights.create(user.id, profileId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.weights.remove(user.id, id);
  }
}
