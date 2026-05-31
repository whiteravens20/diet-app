/**
 * Cookie-based guard for the reviewer interface (Phase H).
 *
 * Refuses entry unless:
 *   1. `InstanceSettings.reviewerEnabled = true` (re-read every request, so
 *      flipping the admin toggle revokes every active session instantly —
 *      no token rotation needed).
 *   2. A `reviewerPasswordHash` is configured.
 *   3. The `reviewer_session` cookie carries a valid JWT signed by
 *      JWT_ACCESS_SECRET with `kind: 'reviewer'`.
 *
 * On success attaches `req.reviewer = { label, locale }` so controllers can
 * scope every operation to the cookie's locale.
 */
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Env } from '../config/env.js';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import {
  REVIEWER_COOKIE_NAME,
  readCookie,
  verifyReviewerCookie,
  type ReviewerSession,
} from './session.js';

export interface ReviewerRequest extends Request {
  reviewer?: ReviewerSession;
}

@Injectable()
export class ReviewerSessionGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    private readonly settings: InstanceSettingsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const { reviewerEnabled, reviewerPasswordHash } =
      await this.settings.readReviewerCredentials();
    if (!reviewerEnabled || reviewerPasswordHash === null) {
      throw new ForbiddenException({
        error: 'REVIEWER_DISABLED',
        message: 'Reviewer interface is disabled.',
      });
    }

    const req = ctx.switchToHttp().getRequest<ReviewerRequest>();
    const cookieHeader = req.headers['cookie'];
    const token = readCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      REVIEWER_COOKIE_NAME,
    );
    if (!token) {
      throw new UnauthorizedException({
        error: 'NO_REVIEWER_SESSION',
        message: 'No reviewer session present.',
      });
    }

    const secret = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    const session = verifyReviewerCookie(this.jwt, secret, token);
    if (!session) {
      throw new UnauthorizedException({
        error: 'INVALID_REVIEWER_SESSION',
        message: 'Reviewer session is invalid or expired.',
      });
    }

    req.reviewer = session;
    return true;
  }
}
