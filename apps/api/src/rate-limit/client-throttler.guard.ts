// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, type ThrottlerModuleOptions, type ThrottlerStorage } from '@nestjs/throttler';
import type { Env } from '../config/env.js';

/**
 * The limiter in front of every route, and whom it counts a request against.
 *
 * Counting by address alone fails behind a proxy: the API sees one address
 * for everybody, so ten bad requests from one visitor used up the allowance
 * of every user. A request is therefore counted against the most specific
 * thing that is known about who sent it:
 *
 *  1. a signed-in user, when the request carries a valid access token;
 *  2. on a route that tries a credential, whose credential it is (see
 *     `trackers.ts`: the account for a sign-in, the token for a refresh);
 *  3. otherwise the client's address, as far as `TRUST_PROXY` lets it be
 *     known.
 *
 * So one user cannot use up another's allowance, and nobody can lock an
 * account out by guessing at a different one. The address is the weakest of
 * the three: behind the web server with `TRUST_PROXY` off it is the same for
 * everybody, and what is counted against it is then one allowance for the
 * whole instance.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  private readonly tokens: JwtService;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService<Env, true>,
  ) {
    super(options, storage, reflector);
    this.tokens = new JwtService({ secret: config.get('JWT_ACCESS_SECRET', { infer: true }) });
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = this.signedInUser(req);
    return user ? `user:${user}` : `addr:${await super.getTracker(req)}`;
  }

  /**
   * The user a request is signed in as, from its access token alone: the
   * signature and the expiry are checked, the database is not asked. This
   * runs before the route's own guard, which decides whether the request is
   * let in; here the token only says whose allowance the request counts
   * against, and a token that does not verify counts against the address.
   */
  private signedInUser(req: Record<string, unknown>): string | null {
    const header = (req.headers as Record<string, string | undefined> | undefined)?.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    try {
      const payload = this.tokens.verify<{ sub?: unknown; kind?: unknown }>(header.slice(7));
      // The same rule as the access-token guard: a user token has a subject and no kind.
      return payload.kind === undefined && typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
