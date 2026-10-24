// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { parseTrustProxy } from '../config/trust-proxy.js';
import { countedAddress } from './client-address.js';

/** The most accounts one client address may open in a day. */
export const SIGN_UPS_PER_ADDRESS_A_DAY = 3;

const DAY_MS = 86_400_000;
/** The most addresses remembered at once; beyond it the one that opened an account longest ago is forgotten. */
const MAX_ADDRESSES = 10_000;

/**
 * How many accounts one client opens in a day. Every account is given what
 * the instance allows an account, the use of the operator's AI provider among
 * it: a client that could open accounts by the dozen would be given that many
 * times as much. The ten sign-ups a minute that every sender may try are no
 * bound on a day.
 *
 * A client is its address as every limit counts it (`countedAddress`), and it
 * is counted only where the address is the client's own, as `TRUST_PROXY`
 * says: behind the web server without it every visitor has the web server's
 * address, and one visitor would keep everybody else from signing up. Only
 * the sign-ups that opened an account count: a refused one (an address that
 * has an account, a password that is too short) gives its place back.
 *
 * Counts live in this process: an instance with several API processes allows
 * as many times the accounts, and a restart forgets them.
 */
@Injectable()
export class SignUps {
  /** When each address opened its accounts of the last day, the address that opened one last at the end. */
  private readonly opened = new Map<string, number[]>();
  private readonly addressKnown: boolean;

  /** The clock, replaceable in a test. */
  now: () => number = Date.now;

  constructor(config: ConfigService<Env, true>) {
    this.addressKnown = parseTrustProxy(config.get('TRUST_PROXY', { infer: true })) !== false;
  }

  /**
   * Take a place for an account that `address` is about to open: refused while
   * it has opened as many in the last day. Returns what gives the place back,
   * for a sign-up that then fails.
   */
  take(address: string | undefined): () => void {
    if (!this.addressKnown) return () => undefined;
    const client = countedAddress(address);
    const now = this.now();
    const recent = (this.opened.get(client) ?? []).filter((at) => at > now - DAY_MS);
    if (recent.length >= SIGN_UPS_PER_ADDRESS_A_DAY) {
      const seconds = Math.ceil((recent[0]! + DAY_MS - now) / 1000);
      throw new HttpException(
        {
          error: 'TOO_MANY_SIGN_UPS',
          message: `This address has opened ${SIGN_UPS_PER_ADDRESS_A_DAY} accounts in the last day. Try again in ${Math.ceil(seconds / 3600)} hours.`,
          retryAfterSeconds: seconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    // Re-inserted, so that the map stays ordered by the latest sign-up.
    this.opened.delete(client);
    this.opened.set(client, recent);
    if (this.opened.size > MAX_ADDRESSES) this.opened.delete(this.opened.keys().next().value!);
    return () => {
      const times = this.opened.get(client);
      const at = times?.lastIndexOf(now) ?? -1;
      if (at >= 0) times!.splice(at, 1);
    };
  }
}
