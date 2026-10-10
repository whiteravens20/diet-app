// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module.js';
import { DraftsModule } from './admin/drafts/drafts.module.js';
import { AiModule } from './ai/ai.module.js';
import { AppConfigModule } from './app-config/app-config.module.js';
import { AuthModule } from './auth/auth.module.js';
import { IGNORE_ENV_FILES, validateEnv, type Env } from './config/env.js';
import { FavoriteSetsModule } from './favorite-sets/favorite-sets.module.js';
import { FavoritesModule } from './favorites/favorites.module.js';
import { HealthModule } from './health/health.module.js';
import { IngredientsModule } from './ingredients/ingredients.module.js';
import { InstanceSettingsModule } from './instance-settings/instance-settings.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { MealPlansModule } from './meal-plans/meal-plans.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ClientThrottlerGuard } from './rate-limit/client-throttler.guard.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { RecipesModule } from './recipes/recipes.module.js';
import { ReviewModule } from './review/review.module.js';
import { ShoppingListsModule } from './shopping-lists/shopping-lists.module.js';
import { UsersModule } from './users/users.module.js';
import { WeightsModule } from './weights/weights.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Repo-root .env for local runs; containers inject the env directly.
      envFilePath: ['../../.env', '.env'],
      ignoreEnvFile: IGNORE_ENV_FILES,
    }),
    // Global rate limiting — active regardless of whether Turnstile is enabled.
    // Whom a request is counted against: see ClientThrottlerGuard.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [
          {
            ttl: config.get('RATE_LIMIT_WINDOW', { infer: true }) * 1000,
            limit: config.get('RATE_LIMIT_MAX', { infer: true }),
          },
        ],
      }),
    }),
    RateLimitModule,
    PrismaModule,
    HealthModule,
    AppConfigModule,
    AuthModule,
    ProfilesModule,
    RecipesModule,
    IngredientsModule,
    MealPlansModule,
    FavoritesModule,
    FavoriteSetsModule,
    ShoppingListsModule,
    AiModule,
    AdminModule,
    DraftsModule,
    InstanceSettingsModule,
    InventoryModule,
    ReviewModule,
    UsersModule,
    WeightsModule,
    NotificationsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ClientThrottlerGuard }],
})
export class AppModule {}
