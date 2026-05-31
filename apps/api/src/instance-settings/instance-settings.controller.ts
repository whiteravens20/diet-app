/**
 * Admin-only management of `InstanceSettings` (Phase H).
 *
 * Exposes:
 *   GET   /api/admin/instance-settings           — current state, never the hash.
 *   PATCH /api/admin/instance-settings           — toggle and/or password.
 *
 * Wider settings can land here later (e.g. signed-up-on/about banners) without
 * earning their own module.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { BasicAuthGuard } from '../admin/basic-auth.guard.js';
import {
  InstanceSettingsService,
  type InstanceSettingsState,
} from './instance-settings.service.js';

const InstanceSettingsPatchBody = z
  .object({
    reviewerEnabled: z.boolean().optional(),
    // Empty string explicitly clears the hash; `undefined` means "no change".
    reviewerPassword: z.string().max(200).optional(),
  })
  .strict();

@Controller('admin/instance-settings')
@UseGuards(BasicAuthGuard)
export class InstanceSettingsController {
  constructor(private readonly service: InstanceSettingsService) {}

  @Get()
  get(): Promise<InstanceSettingsState> {
    return this.service.get();
  }

  @Patch()
  async patch(@Body() body: unknown): Promise<InstanceSettingsState> {
    const parsed = InstanceSettingsPatchBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_INSTANCE_SETTINGS_PATCH',
        message: parsed.error.message,
      });
    }
    return this.service.patch(parsed.data);
  }
}
