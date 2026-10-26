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
import { InstanceSettingsDto, InstanceSettingsPatchBody } from '@diet-app/shared';
import { AdminSessionGuard } from '../admin/admin-session.guard.js';
import { Answers } from '../common/answers.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { InstanceSettingsService } from './instance-settings.service.js';

@Controller('admin/instance-settings')
@UseGuards(AdminSessionGuard)
export class InstanceSettingsController {
  constructor(private readonly service: InstanceSettingsService) {}

  /** What an administrator sets for the instance in the panel: whether reviewers may sign in, and whether their password is set. */
  @Get()
  @Answers(InstanceSettingsDto)
  get(): Promise<InstanceSettingsDto> {
    return this.service.get();
  }

  /** Change those settings. */
  @Patch()
  @Answers(InstanceSettingsDto)
  patch(
    @Body(new ZodValidationPipe(InstanceSettingsPatchBody)) body: InstanceSettingsPatchBody,
  ): Promise<InstanceSettingsDto> {
    return this.service.patch(body);
  }
}
