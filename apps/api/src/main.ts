// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { applySecurityHeaders } from './common/security.js';
import type { Env } from './config/env.js';

/** Where Swagger UI is mounted, global prefix included. */
const SWAGGER_PATH = 'api/docs';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService) as ConfigService<Env, true>;
  const swaggerEnabled = config.get('SWAGGER_ENABLED', { infer: true });

  app.setGlobalPrefix('api');
  // Security headers on /api/* — see common/security.ts. The Swagger routes
  // get their own policy only while Swagger is on.
  applySecurityHeaders(app, swaggerEnabled ? { swaggerPath: `/${SWAGGER_PATH}` } : {});
  app.useGlobalFilters(new AllExceptionsFilter());
  // Input validation is per-route via ZodValidationPipe against packages/shared.
  app.enableCors({ origin: config.get('APP_URL', { infer: true }), credentials: true });

  // OpenAPI — served at /api/docs, JSON at /api/docs-json. Off in production
  // unless explicitly enabled: the schema dump is recon-enabling and there is
  // no reason to expose it on a public instance by default.
  if (swaggerEnabled) {
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
}

void bootstrap();
