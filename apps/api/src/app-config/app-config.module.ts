// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module.js';
import { MailModule } from '../mail/mail.module.js';
import { TurnstileService } from '../auth/turnstile.service.js';
import { AppConfigController } from './app-config.controller.js';

/**
 * Serves GET /api/config. TurnstileService is stateless (reads ConfigService),
 * so it's provided directly here rather than coupling to AuthModule.
 */
@Module({
  imports: [MailModule, CatalogueModule],
  controllers: [AppConfigController],
  providers: [TurnstileService],
})
export class AppConfigModule {}
