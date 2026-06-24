import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

/**
 * Helmet options for the API. CSP is disabled here on purpose — the web layer
 * owns the Content-Security-Policy (see apps/web/src/lib/security-headers.ts),
 * and helmet's default CSP would break the Swagger UI's inline scripts/styles.
 * Everything else (HSTS, X-Content-Type-Options, X-Frame-Options,
 * Referrer-Policy, X-Powered-By removal) is left on for defence in depth.
 */
export const helmetOptions = {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
} as const;

/** Apply the standard API security headers. Called from `main.ts`. */
export function applySecurityHeaders(app: INestApplication): void {
  app.use(helmet(helmetOptions));
}
