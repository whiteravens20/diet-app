import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { RequestUser } from '../common/current-user.decorator.js';
import type { Env } from '../config/env.js';

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: 'user' | 'admin';
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
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
