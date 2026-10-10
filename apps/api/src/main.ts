// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { SWAGGER_PATH, configureApp } from './app.setup.js';
import { describePosture, type Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService) as ConfigService<Env, true>;

  configureApp(app);
  // As PID 1 in a container the process gets no default signal handling: with
  // these hooks a `docker stop` lets requests in flight finish and closes the
  // database pool, instead of being killed after the grace period.
  app.enableShutdownHooks();

  // OpenAPI — served at /api/docs, JSON at /api/docs-json. Off in production
  // unless explicitly enabled: the schema dump is recon-enabling and there is
  // no reason to expose it on a public instance by default.
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const swagger = new DocumentBuilder()
      .setTitle('Diet App API')
      .setDescription('Deterministic diet & meal-planning API. See packages/shared for contracts.')
      .setVersion('0.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(SWAGGER_PATH, app, SwaggerModule.createDocument(app, swagger));
    Logger.log(`Swagger UI enabled at /${SWAGGER_PATH}`, 'Bootstrap');
  }

  const port = config.get('API_PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  Logger.log(`Diet App API listening on :${port}`, 'Bootstrap');
  const posture = describePosture({
    NODE_ENV: config.get('NODE_ENV', { infer: true }),
    APP_URL: config.get('APP_URL', { infer: true }),
    ADMIN_PASSWORD: config.get('ADMIN_PASSWORD', { infer: true }),
    SMTP_HOST: config.get('SMTP_HOST', { infer: true }),
    SMTP_PORT: config.get('SMTP_PORT', { infer: true }),
    AI_DEFAULT_PROVIDER: config.get('AI_DEFAULT_PROVIDER', { infer: true }),
    AI_ADMIN_USER_MONTHLY_LIMIT: config.get('AI_ADMIN_USER_MONTHLY_LIMIT', { infer: true }),
    AI_ADMIN_INSTANCE_MONTHLY_LIMIT: config.get('AI_ADMIN_INSTANCE_MONTHLY_LIMIT', { infer: true }),
    SWAGGER_ENABLED: config.get('SWAGGER_ENABLED', { infer: true }),
  });
  for (const line of posture) {
    if (line.startsWith('!')) Logger.warn(line.slice(1).trim(), 'Posture');
    else Logger.log(line, 'Posture');
  }
}

void bootstrap();
