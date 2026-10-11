// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The gate of every admin route: the administrator's session cookie.
 * Fail-closed: while ADMIN_PASSWORD is empty or still the placeholder every
 * request is refused, so the panel can never be opened by accident. A request
 * that changes something has to come from the application's own pages.
 */
import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertFromTheApplication } from '../auth/session-cookies.js';
import { readCookie } from '../common/cookies.js';
import { ADMIN_PASSWORD_PLACEHOLDER, type Env, isAdminEnabled } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ADMIN_COOKIE, isAdminSession } from './admin-session.js';

/**
 * The epoch an admin session has to be of to count. Read without writing:
 * this runs for every admin request, and two that arrive together must not
 * both try to make the settings row. An instance that has none yet is in its
 * first epoch.
 */
export async function adminSessionEpoch(prisma: PrismaService): Promise<number> {
  const row = await prisma.instanceSettings.findUnique({ where: { id: 'singleton' }, select: { adminSessionEpoch: true } });
  return row?.adminSessionEpoch ?? 0;
}

/** Refuse while the instance has no administrator's password. */
export function assertAdminEnabled(config: ConfigService<Env, true>): void {
  const adminPassword = config.get('ADMIN_PASSWORD', { infer: true });
  if (isAdminEnabled({ ADMIN_PASSWORD: adminPassword })) return;
  throw new ForbiddenException({
    error: 'ADMIN_DISABLED',
    message:
      adminPassword.length === 0
        ? 'Admin panel is disabled. Set ADMIN_PASSWORD to enable.'
        : `Admin panel is disabled. ADMIN_PASSWORD is still "${ADMIN_PASSWORD_PLACEHOLDER}".`,
  });
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    assertAdminEnabled(this.config);
    const req = ctx.switchToHttp().getRequest<{ method: string; headers: Record<string, string | undefined> }>();
    const token = readCookie(req.headers['cookie'], ADMIN_COOKIE);
    if (!token) {
      throw new UnauthorizedException({ error: 'AUTH_REQUIRED', message: 'Authentication required.' });
    }
    if (!isAdminSession(this.config, token, await adminSessionEpoch(this.prisma))) {
      throw new UnauthorizedException({ error: 'INVALID_ADMIN_SESSION', message: 'The admin session is invalid or has ended.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      assertFromTheApplication(req.headers['origin'], this.config.get('APP_URL', { infer: true }));
    }
    return true;
  }
}
