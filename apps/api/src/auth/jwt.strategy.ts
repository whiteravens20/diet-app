// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { RequestUser } from '../common/current-user.decorator.js';
import type { Env } from '../config/env.js';
import { SessionsService } from './sessions.service.js';
import { ACCOUNT_AUDIENCE, TOKEN_ALGORITHM } from './token-kinds.js';

interface AccessTokenPayload {
  sub: string;
  sid: string;
}

const refused = (): UnauthorizedException =>
  new UnauthorizedException({ error: 'INVALID_ACCESS_TOKEN', message: 'Invalid access token.' });
const named = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Validates the Bearer access token and exposes the principal as
 * `request.user`. Only a token signed in the one way access tokens are, and
 * made for an account calling the API, gets as far as `validate`.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<Env, true>,
    private readonly sessions: SessionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
      algorithms: [TOKEN_ALGORITHM],
      audience: ACCOUNT_AUDIENCE,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<RequestUser> {
    // A token that names nobody must not authenticate: `{ id: undefined }`
    // would be a phantom user, and a `where: { userId: undefined }` further
    // on matches every row (Prisma takes `undefined` for "no filter").
    if (!named(payload.sub) || !named(payload.sid)) throw refused();
    // Nor one whose session has ended, or whose account is gone: a token
    // outlives either by up to a quarter of an hour, and until then would go
    // on working after a sign-out, and write for nobody after a deletion.
    if (!(await this.sessions.isOpen(payload.sub, payload.sid))) throw refused();
    return { id: payload.sub, sessionId: payload.sid };
  }
}
