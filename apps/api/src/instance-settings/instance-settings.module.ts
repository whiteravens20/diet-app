// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminSessionGuard } from '../admin/admin-session.guard.js';
import { InstanceSettingsController } from './instance-settings.controller.js';
import { InstanceSettingsService } from './instance-settings.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [InstanceSettingsController],
  providers: [AdminSessionGuard, InstanceSettingsService],
  exports: [InstanceSettingsService],
})
export class InstanceSettingsModule {}
