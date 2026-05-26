/**
 * F16 admin gate. HTTP Basic against ADMIN_USER / ADMIN_PASSWORD, constant-
 * time compare. Fail-closed: when ADMIN_PASSWORD is empty / placeholder,
 * every request returns 403 so the panel can never be opened by accident.
 *
 * Mirrors archivum-null/backend/src/middleware/basicAuth.ts.
 */
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { ADMIN_PASSWORD_PLACEHOLDER, type Env, isAdminEnabled } from '../config/env.js';

const REALM = 'Diet App Admin';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare with self so the work done on a length mismatch matches the
    // work done on a length match — no early-exit timing signal.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

@Injectable()
export class BasicAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(ctx: ExecutionContext): boolean {
    const adminPassword = this.config.get('ADMIN_PASSWORD', { infer: true });
    const adminUser = this.config.get('ADMIN_USER', { infer: true });
    if (!isAdminEnabled({ ADMIN_PASSWORD: adminPassword })) {
      throw new ForbiddenException(
        adminPassword.length === 0
          ? 'Admin panel is disabled. Set ADMIN_PASSWORD to enable.'
          : `Admin panel is disabled. ADMIN_PASSWORD is still "${ADMIN_PASSWORD_PLACEHOLDER}".`,
      );
    }

    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const res = ctx
      .switchToHttp()
      .getResponse<{ setHeader: (k: string, v: string) => void }>();
    const header = req.headers['authorization'];

    if (!header || !header.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
      throw new UnauthorizedException('Authentication required');
    }

    let user: string;
    let pass: string;
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
      const [u, ...rest] = decoded.split(':');
      user = u;
      pass = rest.join(':');
    } catch {
      res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
      throw new UnauthorizedException('Invalid authorization header');
    }

    // Execute both comparisons unconditionally so a wrong username doesn't
    // short-circuit and leak that the username alone was right.
    const userOk = safeCompare(user, adminUser);
    const passOk = safeCompare(pass, adminPassword);
    if (!userOk || !passOk) {
      res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
      throw new UnauthorizedException('Invalid credentials');
    }
    return true;
  }
}
