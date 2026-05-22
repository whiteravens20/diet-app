import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { AiProviderConfigInput } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AiKeyService } from './ai-key.service.js';

/** Per-user AI provider configuration. API keys are write-only. */
@Controller('ai/providers')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly keys: AiKeyService) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.keys.list(user.id);
  }

  @Put()
  upsert(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(AiProviderConfigInput)) dto: AiProviderConfigInput,
  ) {
    return this.keys.upsert(user.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.keys.remove(user.id, id);
  }
}
