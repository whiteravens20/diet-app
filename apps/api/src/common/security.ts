// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { INestApplication } from '@nestjs/common';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Helmet options for the API. Its responses are JSON, so the policy lets
 * nothing load and nothing frame them: a response a browser is ever made to
 * render as a document cannot run script. The web layer owns the policy for
 * the pages themselves (see apps/web/src/lib/security-headers.ts). Everything
 * else (X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
 * X-Powered-By removal) stays on helmet's defaults, but for HSTS: see
 * {@link transport}.
 */
const helmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
} as const;

/**
 * Swagger UI is the one page the API serves, and only when SWAGGER_ENABLED is
 * set. It loads its scripts and stylesheet from this origin, styles itself
 * inline and fetches the OpenAPI document, so its routes get exactly that much
 * and still may not be framed.
 */
const swaggerHelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
} as const;

export interface SecurityHeadersOptions {
  /** Path Swagger UI is mounted on, with the global prefix (`/api/docs`). Unset when it is off. */
  swaggerPath?: string;
  /** The instance's public address is https. */
  https?: boolean;
}

/**
 * Whether a browser is told to keep to https, and for how long: only by an
 * instance whose public address is https, and then for two years, as the web
 * application says it. Over plain http a browser ignores the header, and a
 * home instance on a LAN address runs that way.
 */
const transport = (https: boolean | undefined) => ({
  strictTransportSecurity: https ? { maxAge: 63_072_000, includeSubDomains: true, preload: false } : false,
});

/** The API's security-header middleware: the strict policy, and the Swagger one on its own routes. */
export function securityHeaders(options: SecurityHeadersOptions = {}): RequestHandler {
  const strict = helmet({ ...helmetOptions, ...transport(options.https) });
  const { swaggerPath } = options;
  if (!swaggerPath) return strict;

  const swagger = helmet({ ...swaggerHelmetOptions, ...transport(options.https) });
  return (req, res, next) => {
    const onSwagger = req.path === swaggerPath || req.path.startsWith(`${swaggerPath}/`);
    (onSwagger ? swagger : strict)(req, res, next);
  };
}

/** Apply the standard API security headers. Called from `main.ts`. */
export function applySecurityHeaders(
  app: INestApplication,
  options: SecurityHeadersOptions = {},
): void {
  app.use(securityHeaders(options));
}
