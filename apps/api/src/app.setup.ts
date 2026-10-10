// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { applySecurityHeaders } from './common/security.js';
import type { Env } from './config/env.js';
import { parseTrustProxy } from './config/trust-proxy.js';

/** Where Swagger UI is mounted, global prefix included. */
export const SWAGGER_PATH = 'api/docs';

/**
 * Everything a request passes through before it reaches a controller: whose
 * word is taken for the client's address, the `/api` prefix, the security
 * headers, the error envelope and CORS. The server
 * entry point and the integration tests both call this, so a test exercises the
 * pipeline the API ships.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService) as ConfigService<Env, true>;
  const swaggerEnabled = config.get('SWAGGER_ENABLED', { infer: true });

  // Before anything reads a client's address: how far `X-Forwarded-For` is
  // believed. Off unless the operator says which proxies wrote it.
  const trustProxy = parseTrustProxy(config.get('TRUST_PROXY', { infer: true }));
  if (trustProxy !== false) app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);

  app.setGlobalPrefix('api');
  // Security headers on /api/* — see common/security.ts. The Swagger routes
  // get their own policy only while Swagger is on.
  applySecurityHeaders(app, swaggerEnabled ? { swaggerPath: `/${SWAGGER_PATH}` } : {});
  app.useGlobalFilters(new AllExceptionsFilter());
  // Input validation is per-route via ZodValidationPipe against packages/shared.
  app.enableCors({ origin: config.get('APP_URL', { infer: true }), credentials: true });
}
