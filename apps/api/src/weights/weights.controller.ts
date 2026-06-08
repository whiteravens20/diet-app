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
import { z } from 'zod';
import { WeightEntryInput } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { WeightsService } from './weights.service.js';

const CreateBody = WeightEntryInput.extend({ profileId: z.string().uuid() });
type CreateBody = z.infer<typeof CreateBody>;

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
    @Query('profileId') profileId: string,
    @Query('since') since?: string,
  ) {
    const sinceDate = since ? new Date(since) : undefined;
    return this.weights.list(user.id, profileId, sinceDate);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(CreateBody)) dto: CreateBody,
  ) {
    const { profileId, ...body } = dto;
    return this.weights.create(user.id, profileId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.weights.remove(user.id, id);
  }
}
