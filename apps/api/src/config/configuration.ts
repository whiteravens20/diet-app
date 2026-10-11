// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConfigModule } from '@nestjs/config';
import { IGNORE_ENV_FILES, validateEnv } from './env.js';

/** The settings of the instance, read and checked once, for the API and for the worker alike. */
export const Configuration = ConfigModule.forRoot({
  isGlobal: true,
  validate: validateEnv,
  // Only what validation let through is handed out. Without this a setting
  // that validation dropped, a blank one above all, is read from the
  // process environment after all, as an empty string.
  skipProcessEnv: true,
  // Repo-root .env for local runs; containers inject the env directly.
  envFilePath: ['../../.env', '.env'],
  ignoreEnvFile: IGNORE_ENV_FILES,
});
