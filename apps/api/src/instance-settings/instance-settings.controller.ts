// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Admin-only management of `InstanceSettings`.
 *
 * Exposes:
 *   GET   /api/admin/instance-settings           — current state, never the hash.
 *   PATCH /api/admin/instance-settings           — toggle and/or password.
 *
 * Wider settings can land here later (e.g. signed-up-on/about banners) without
 * earning their own module.
 */
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { InstanceSettingsPatchBody } from '@diet-app/shared';
import { AdminSessionGuard } from '../admin/admin-session.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { InstanceSettingsService, type InstanceSettingsState } from './instance-settings.service.js';

@Controller('admin/instance-settings')
@UseGuards(AdminSessionGuard)
export class InstanceSettingsController {
  constructor(private readonly service: InstanceSettingsService) {}

  @Get()
  get(): Promise<InstanceSettingsState> {
    return this.service.get();
  }

  @Patch()
  patch(@Body(new ZodValidationPipe(InstanceSettingsPatchBody)) body: InstanceSettingsPatchBody): Promise<InstanceSettingsState> {
    return this.service.patch(body);
  }
}
