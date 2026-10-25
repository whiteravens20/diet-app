// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { AuthModule } from './auth/auth.module.js';
import { PasswordsModule } from './common/passwords.js';
import { Configuration } from './config/configuration.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { PersonalRecipesModule } from './recipes/personal-recipes.module.js';

/**
 * What the worker's jobs need, and no more: the accounts, the stored keys,
 * the personal recipes and the notifications. The plans, the catalogue, the
 * administrator's runners and the limiter of requests are the API's.
 */
@Module({
  imports: [
    Configuration,
    PrismaModule,
    PasswordsModule,
    AuthModule,
    AiModule,
    PersonalRecipesModule,
    NotificationsModule,
  ],
})
export class WorkerModule {}
