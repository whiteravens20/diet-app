import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module.js';
import { DraftsModule } from './admin/drafts/drafts.module.js';
import { AiModule } from './ai/ai.module.js';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv, type Env } from './config/env.js';
import { FavoritesModule } from './favorites/favorites.module.js';
import { HealthModule } from './health/health.module.js';
import { IngredientsModule } from './ingredients/ingredients.module.js';
import { MealPlansModule } from './meal-plans/meal-plans.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { RecipesModule } from './recipes/recipes.module.js';
import { ShoppingListsModule } from './shopping-lists/shopping-lists.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Repo-root .env for local runs; containers inject the env directly.
      envFilePath: ['../../.env', '.env'],
    }),
    // Global rate limiting — active regardless of whether Turnstile is enabled.
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
    PrismaModule,
    HealthModule,
    AuthModule,
    ProfilesModule,
    RecipesModule,
    IngredientsModule,
    MealPlansModule,
    FavoritesModule,
    ShoppingListsModule,
    AiModule,
    AdminModule,
    DraftsModule,
    UsersModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
