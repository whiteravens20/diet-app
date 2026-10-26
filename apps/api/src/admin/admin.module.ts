// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogueModule } from '../catalogue/catalogue.module.js';
import { MailModule } from '../mail/mail.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminAccountsController } from './admin-accounts.controller.js';
import { AdminController } from './admin.controller.js';
import { AdminSecondFactorReset } from './admin-second-factor-reset.js';
import { AdminSessionController } from './admin-session.controller.js';
import { AdminSessionGuard } from './admin-session.guard.js';
import { InstanceFilesModule } from './drafts/ship/instance-files.module.js';
import { OperatorAiApprovals } from './operator-ai-approvals.service.js';
import { SeedRunner } from './seed/runner.js';
import { UsdaImportRunner } from './usda/runner.js';

/**
 * Admin module — isolated namespace under `/api/admin/*`. No account: the
 * administrator signs in with ADMIN_USER / ADMIN_PASSWORD for a session
 * cookie (`AdminSessionController`), which `AdminSessionGuard` asks for.
 */
@Module({
  imports: [PrismaModule, AuthModule, CatalogueModule, MailModule, InstanceFilesModule],
  controllers: [AdminController, AdminAccountsController, AdminSessionController],
  providers: [
    AdminSecondFactorReset,
    AdminSessionGuard,
    OperatorAiApprovals,
    SeedRunner,
    UsdaImportRunner,
  ],
})
export class AdminModule {}
