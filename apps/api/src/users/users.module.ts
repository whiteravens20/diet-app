// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AccountExportService } from './account-export.service.js';
import { SecondFactorController } from './second-factor.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule, MailModule],
  controllers: [UsersController, SecondFactorController],
  providers: [UsersService, AccountExportService],
  exports: [UsersService],
})
export class UsersModule {}
