import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService) as ConfigService<Env, true>;

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  // Input validation is per-route via ZodValidationPipe against packages/shared.
  app.enableCors({ origin: config.get('APP_URL', { infer: true }), credentials: true });

  // OpenAPI — served at /api/docs, JSON at /api/docs-json.
  const swagger = new DocumentBuilder()
    .setTitle('Diet App API')
    .setDescription('Deterministic diet & meal-planning API. See packages/shared for contracts.')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));

  const port = config.get('API_PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  Logger.log(`Diet App API listening on :${port}`, 'Bootstrap');
}

void bootstrap();
