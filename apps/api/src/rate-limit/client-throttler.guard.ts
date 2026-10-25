// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Env } from '../config/env.js';
import { parseTrustProxy } from '../config/trust-proxy.js';
import { countedAddress } from './client-address.js';
import { CREDENTIAL_COUNTS, type CredentialCount } from './trackers.js';

/**
 * The limiter in front of every route, and whom it counts a request against.
 *
 * Every request is counted against its sender: the signed-in user when it
 * carries a valid access token, otherwise the client's address. A route that
 * tries a credential is counted by that credential on top (see `trackers.ts`:
 * the account and the address together for a sign-in, the token for a
 * refresh), so that guessing at one account uses up nobody else's tries.
 *
 * An address says who the sender is only as far as `TRUST_PROXY` lets it be
 * known. Behind the web server with `TRUST_PROXY` off it is the same for
 * everybody, and what is counted against it is one allowance for the whole
 * instance. On a route that tries a credential that would let a handful of
 * requests keep every user out, so there the address is counted only once
 * `TRUST_PROXY` says whose word to take for it.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  private readonly tokens: JwtService;
  /** Whether the address of a request is its sender's: the operator said which proxies write it. */
  private readonly addressKnown: boolean;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService<Env, true>,
  ) {
    super(options, storage, reflector);
    this.tokens = new JwtService({ secret: config.get('JWT_ACCESS_SECRET', { infer: true }) });
    this.addressKnown = parseTrustProxy(config.get('TRUST_PROXY', { infer: true })) !== false;
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = this.signedInUser(req);
    return user ? `user:${user}` : `addr:${countedAddress(req.ip)}`;
  }

  /**
   * Count one request against its sender, and a route that tries a
   * credential (`@TriesCredential`) by each thing it names as well, in that
   * order. Whichever runs out first refuses the request.
   */
  protected override async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const { context } = request;
    const counts = this.reflector.getAllAndOverride<CredentialCount[] | undefined>(
      CREDENTIAL_COUNTS,
      [context.getHandler(), context.getClass()],
    );
    if (!counts) return super.handleRequest(request);

    const sender = await this.getTracker(this.getRequestResponse(context).req);
    // Not an address that everybody behind the proxy shares: see above.
    if (this.addressKnown || sender.startsWith('user:')) {
      await super.handleRequest({ ...request, getTracker: () => sender });
    }
    for (const count of counts) {
      await super.handleRequest({
        ...request,
        limit: count.limit,
        ttl: count.ttl,
        blockDuration: count.ttl,
        getTracker: count.by,
      });
    }
    return true;
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
      return payload.kind === undefined && typeof payload.sub === 'string' && payload.sub.length > 0
        ? payload.sub
        : null;
    } catch {
      return null;
    }
  }
}
