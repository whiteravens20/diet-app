// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AiProviderConfig,
  AiProviderConfigInput,
  AiQuotaStatus,
  AiTestConnectionRequest,
  AiTestConnectionResponse,
} from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiKeyService } from './ai-key.service.js';
import { AiQuotaService } from './ai-quota.service.js';
import { AiTestService } from './ai-test.service.js';
import { AiMode as AiModeSchema, type AiMode } from '@diet-app/shared';

/** Per-user AI provider configuration. API keys are write-only. */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly keys: AiKeyService,
    private readonly quota: AiQuotaService,
    private readonly test: AiTestService,
    private readonly prisma: PrismaService,
  ) {}

  /** The AI providers the account has set up, without their keys. */
  @Get('providers')
  @AnswersListOf(AiProviderConfig)
  listProviders(@CurrentUser() user: RequestUser) {
    return this.keys.list(user.id);
  }

  /** Save the account's configuration of a provider: made the first time, changed afterwards. A key that is left out stays as it is. */
  @Put('providers')
  @Answers(AiProviderConfig)
  upsertProvider(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(AiProviderConfigInput)) dto: AiProviderConfigInput,
  ) {
    return this.keys.upsert(user.id, dto);
  }

  /** Remove a provider of the account, with its key. */
  @Delete('providers/:id')
  @HttpCode(204)
  async removeProvider(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.keys.remove(user.id, id);
  }

  /**
   * What AI the account has now: the mode it chose, and how many calls of the
   * instance's allowance it has made and has left.
   */
  @Get('quota')
  @Answers(AiQuotaStatus)
  async getQuota(@CurrentUser() user: RequestUser): Promise<AiQuotaStatus> {
    return this.quota.status(user.id, await this.loadMode(user.id));
  }

  /**
   * Verify a provider credential without persisting it. The UI calls this
   * from the BYOK form to confirm the key works and populate the model
   * dropdown.
   *
   * Throttled tighter than the global default: each call makes an *outbound*
   * request to a user-named provider (including a user-supplied Ollama base URL,
   * bounded by the SSRF policy), so it's an abuse / cost / probe vector if left
   * at the loose 120/min global limit.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('test')
  @Answers(AiTestConnectionResponse)
  async testConnection(
    @Body(new ZodValidationPipe(AiTestConnectionRequest)) dto: AiTestConnectionRequest,
  ): Promise<AiTestConnectionResponse> {
    return this.test.test(dto);
  }

  private async loadMode(userId: string): Promise<AiMode> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { aiMode: true },
    });
    if (!row) return 'none';
    const parsed = AiModeSchema.safeParse(row.aiMode);
    return parsed.success ? parsed.data : 'none';
  }
}
