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
import {
  AiProviderConfigInput,
  AiTestConnectionRequest,
  type AiQuotaStatus,
  type AiTestConnectionResponse,
} from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
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

  @Get('providers')
  listProviders(@CurrentUser() user: RequestUser) {
    return this.keys.list(user.id);
  }

  @Put('providers')
  upsertProvider(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(AiProviderConfigInput)) dto: AiProviderConfigInput,
  ) {
    return this.keys.upsert(user.id, dto);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  async removeProvider(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.keys.remove(user.id, id);
  }

  /**
   * Snapshot of the caller's AI routing state — the app-shell chip and the
   * Settings AI card render straight from this.
   */
  @Get('quota')
  async getQuota(@CurrentUser() user: RequestUser): Promise<AiQuotaStatus> {
    return this.quota.status(user.id, await this.loadMode(user.id));
  }

  /**
   * Verify a provider credential without persisting it. The UI calls this
   * from the BYOK form to confirm the key works and populate the model
   * dropdown.
   */
  @Post('test')
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
