// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { SWAGGER_PATH, configureApp } from './app.setup.js';
import { describePosture, type Env } from './config/env.js';

/**
 * The contract as the repository publishes it, read from where the process
 * runs: the root of the repository or of the image, or the API's own
 * directory under it. Null where the file is not there.
 */
function publishedContract(): OpenAPIObject | null {
  const path = ['docs/api/openapi.json', '../../docs/api/openapi.json'].map((candidate) => resolve(process.cwd(), candidate)).find((candidate) => existsSync(candidate));
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as OpenAPIObject) : null;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService) as ConfigService<Env, true>;

  configureApp(app);
  // As PID 1 in a container the process gets no default signal handling: with
  // these hooks a `docker stop` lets requests in flight finish and closes the
  // database pool, instead of being killed after the grace period.
  app.enableShutdownHooks();

  // The published contract (`docs/api/openapi.json`, written by `npm run
  // contract`), shown at /api/docs and served as JSON at /api/docs-json. Off
  // in production unless switched on: it lays the whole API out, and a public
  // instance has no reason to do that for a visitor.
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const contract = publishedContract();
    if (contract) {
      SwaggerModule.setup(SWAGGER_PATH, app, contract);
      Logger.log(`The contract of the API is shown at /${SWAGGER_PATH}`, 'Bootstrap');
    } else {
      Logger.warn('SWAGGER_ENABLED is on, and docs/api/openapi.json was not found: nothing is shown at /api/docs.', 'Bootstrap');
    }
  }

  const port = config.get('API_PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  Logger.log(`Diet App API listening on :${port}`, 'Bootstrap');
  const posture = describePosture({
    NODE_ENV: config.get('NODE_ENV', { infer: true }),
    APP_URL: config.get('APP_URL', { infer: true }),
    ADMIN_PASSWORD: config.get('ADMIN_PASSWORD', { infer: true }),
    ADMIN_SECOND_FACTOR_RESET: config.get('ADMIN_SECOND_FACTOR_RESET', { infer: true }),
    SMTP_HOST: config.get('SMTP_HOST', { infer: true }),
    SMTP_PORT: config.get('SMTP_PORT', { infer: true }),
    SMTP_REQUIRE_TLS: config.get('SMTP_REQUIRE_TLS', { infer: true }),
    AI_DEFAULT_PROVIDER: config.get('AI_DEFAULT_PROVIDER', { infer: true }),
    AI_ADMIN_USER_MONTHLY_LIMIT: config.get('AI_ADMIN_USER_MONTHLY_LIMIT', { infer: true }),
    AI_ADMIN_INSTANCE_MONTHLY_LIMIT: config.get('AI_ADMIN_INSTANCE_MONTHLY_LIMIT', { infer: true }),
    AI_ADMIN_ACCESS: config.get('AI_ADMIN_ACCESS', { infer: true }),
    AI_ADMIN_NEW_ACCOUNT_DAYS: config.get('AI_ADMIN_NEW_ACCOUNT_DAYS', { infer: true }),
    AI_ADMIN_NEW_ACCOUNTS_PERCENT: config.get('AI_ADMIN_NEW_ACCOUNTS_PERCENT', { infer: true }),
    SWAGGER_ENABLED: config.get('SWAGGER_ENABLED', { infer: true }),
    TRUST_PROXY: config.get('TRUST_PROXY', { infer: true }),
  });
  for (const line of posture) {
    if (line.startsWith('!')) Logger.warn(line.slice(1).trim(), 'Posture');
    else Logger.log(line, 'Posture');
  }
}

void bootstrap();
