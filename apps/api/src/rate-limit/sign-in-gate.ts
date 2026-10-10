// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { isIP } from 'node:net';

/** The wrong sign-in in a row after which a client has to wait. */
const ATTEMPTS_BEFORE_WAIT = 5;
/** The first wait. Every further failure doubles it, up to the longest. */
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 15 * 60_000;
/** A client that has not failed for this long starts from nothing again. */
const FORGET_AFTER_MS = 60 * 60_000;
/** The most clients remembered at once; beyond it the oldest are forgotten. */
const MAX_CLIENTS = 10_000;

interface Attempts {
  failures: number;
  lastFailure: number;
  blockedUntil: number;
}

/**
 * A client as the gate remembers and logs it: its address. Where a proxy that
 * is set up wrongly lets something else arrive in its place, that is one
 * client called `unknown`, not a text of any length kept in memory and
 * written into the log.
 */
const named = (client: string): string => (isIP(client) ? client : 'unknown');

/**
 * Slows down guessing at a password that has no account behind it to count
 * attempts against: the administrator's and the reviewers'.
 *
 * After its fifth wrong sign-in in a row a client has to wait before the next
 * attempt is even looked at: 30 seconds, then twice as long after each further
 * failure, up to a quarter of an hour. A correct sign-in clears the count.
 * Every failure is logged with the client's address, so that an operator sees
 * an attack in the log.
 *
 * A client is its address. Behind the web server with `TRUST_PROXY` off that
 * is one address for everybody: guessing then also keeps the real
 * administrator waiting. The log says so, and the remedy is `TRUST_PROXY`.
 *
 * Counts live in this process: an instance with several API processes allows
 * as many times the attempts, and a restart forgets them.
 */
@Injectable()
export class SignInGate {
  private readonly logger = new Logger('SignIn');
  private readonly clients = new Map<string, Attempts>();

  /** The clock, replaceable in a test. */
  now: () => number = Date.now;

  /**
   * Refuse a client that has to wait, before its credential is looked at:
   * while it waits, a right guess is worth as little as a wrong one.
   */
  assertOpen(door: string, client: string, res?: { setHeader(name: string, value: string): void }): void {
    const entry = this.clients.get(`${door}:${named(client)}`);
    if (!entry) return;
    const wait = entry.blockedUntil - this.now();
    if (wait <= 0) return;
    const seconds = Math.ceil(wait / 1000);
    res?.setHeader('Retry-After', String(seconds));
    throw new HttpException(
      { error: 'TOO_MANY_ATTEMPTS', message: `Too many failed sign-ins. Try again in ${seconds} seconds.` },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Count a wrong sign-in, and say so in the log. */
  failed(door: string, client: string): void {
    const now = this.now();
    this.forgetOld(now);
    const name = named(client);
    const key = `${door}:${name}`;
    const entry = this.clients.get(key) ?? { failures: 0, lastFailure: now, blockedUntil: 0 };
    entry.failures += 1;
    entry.lastFailure = now;
    const beyond = entry.failures - ATTEMPTS_BEFORE_WAIT;
    if (beyond >= 0) entry.blockedUntil = now + Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** beyond);
    // Re-inserted, so that the map stays ordered by the latest failure.
    this.clients.delete(key);
    this.clients.set(key, entry);
    const wait = beyond >= 0 ? `; next attempt in ${Math.ceil((entry.blockedUntil - now) / 1000)} s` : '';
    this.logger.warn(`failed ${door} sign-in from ${name} (${entry.failures} in a row${wait})`);
  }

  /** A correct sign-in: the client starts from nothing. */
  succeeded(door: string, client: string): void {
    this.clients.delete(`${door}:${named(client)}`);
  }

  private forgetOld(now: number): void {
    for (const [key, entry] of this.clients) {
      if (now - entry.lastFailure < FORGET_AFTER_MS && this.clients.size <= MAX_CLIENTS) break;
      this.clients.delete(key);
    }
  }
}
