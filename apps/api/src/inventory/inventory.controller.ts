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
import { z } from 'zod';
import {
  PatchInventoryItem,
  UpsertInventoryItem,
  type Locale,
} from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { InventoryService } from './inventory.service.js';

const UpsertBody = UpsertInventoryItem.extend({ profileId: z.string().uuid() });
type UpsertBody = z.infer<typeof UpsertBody>;

@Controller('inventory')
@UseGuards(JwtAuthGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Query('profileId') profileId: string,
  ) {
    return this.inventory.list(user.id, locale, profileId);
  }

  @Post()
  upsert(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Body(new ZodValidationPipe(UpsertBody)) dto: UpsertBody,
  ) {
    const { profileId, ...body } = dto;
    return this.inventory.upsert(user.id, locale, profileId, body);
  }

  @Patch(':id')
  patch(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PatchInventoryItem)) dto: PatchInventoryItem,
  ) {
    return this.inventory.patch(user.id, locale, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.inventory.remove(user.id, id);
  }
}
