// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminController } from './admin.controller.js';
import { BasicAuthGuard } from './basic-auth.guard.js';
import { SeedRunner } from './seed/runner.js';
import { UsdaImportRunner } from './usda/runner.js';

/**
 * Admin module — isolated namespace under `/api/admin/*`. No JWT, no
 * user identity; auth is HTTP Basic checked against ADMIN_USER / ADMIN_PASSWORD
 * by `BasicAuthGuard`.
 */
@Module({
  imports: [PrismaModule, AiModule],
  controllers: [AdminController],
  providers: [BasicAuthGuard, SeedRunner, UsdaImportRunner],
})
export class AdminModule {}
