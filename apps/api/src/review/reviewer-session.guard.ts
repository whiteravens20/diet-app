// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Cookie-based guard for the reviewer interface.
 *
 * Refuses entry unless:
 *   1. `InstanceSettings.reviewerEnabled = true` (re-read every request, so
 *      closing the panel shuts every session out at once).
 *   2. A `reviewerPasswordHash` is configured.
 *   3. The `reviewer_session` cookie carries a valid token of a reviewer
 *      session, signed with the reviewer key, of the epoch the settings
 *      are in: a changed password or a closed panel ended the ones before.
 *   4. A request that changes something comes from the application's pages.
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
import { assertFromTheApplication } from '../auth/session-cookies.js';
import { readCookie } from '../common/cookies.js';
import type { Env } from '../config/env.js';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import {
  REVIEWER_COOKIE_NAME,
  resolveReviewerSecret,
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
    const { reviewerEnabled, reviewerPasswordHash, reviewerSessionEpoch } = await this.settings.readReviewerCredentials();
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

    const secret = resolveReviewerSecret(this.config);
    const session = verifyReviewerCookie(this.jwt, secret, token, reviewerSessionEpoch);
    if (!session) {
      throw new UnauthorizedException({
        error: 'INVALID_REVIEWER_SESSION',
        message: 'Reviewer session is invalid or expired.',
      });
    }
    // A request that changes something has to come from the application's own pages.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      assertFromTheApplication(req.headers['origin'] as string | undefined, this.config.get('APP_URL', { infer: true }));
    }

    req.reviewer = session;
    return true;
  }
}
