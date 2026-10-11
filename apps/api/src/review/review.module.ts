// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DraftsModule } from '../admin/drafts/drafts.module.js';
import { InstanceSettingsModule } from '../instance-settings/instance-settings.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ReviewController } from './review.controller.js';
import { ReviewerSessionGuard } from './reviewer-session.guard.js';

@Module({
  imports: [PrismaModule, JwtModule.register({}), InstanceSettingsModule, DraftsModule],
  controllers: [ReviewController],
  providers: [ReviewerSessionGuard],
})
export class ReviewModule {}
