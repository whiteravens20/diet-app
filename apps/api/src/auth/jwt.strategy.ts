// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { RequestUser } from '../common/current-user.decorator.js';
import type { Env } from '../config/env.js';

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: 'user' | 'admin';
  /** Present only on non-user tokens (e.g. the reviewer-session cookie). */
  kind?: string;
}

/** Validates the Bearer access token and exposes the principal as `request.user`. */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  validate(payload: AccessTokenPayload): RequestUser {
    // Only a genuine user access token may authenticate here. The reviewer-
    // session cookie is a JWT signed with the same secret (when
    // REVIEWER_SESSION_SECRET is unset it falls back to JWT_ACCESS_SECRET) but
    // carries `kind: 'reviewer'` and no `sub`. Without this guard such a token
    // would pass signature + expiry checks and `validate` would return
    // `{ id: undefined }` — authenticating as a phantom user. A downstream
    // `where: { userId: undefined }` then matches *every* row (Prisma treats
    // `undefined` as "no filter"), leaking all users' data. Reject anything
    // that isn't a plain, `sub`-bearing user token.
    if (payload.kind !== undefined || typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedException({
        error: 'INVALID_ACCESS_TOKEN',
        message: 'Invalid access token.',
      });
    }
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
