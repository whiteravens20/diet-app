// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ServiceUnavailableException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

/**
 * Hashing and checking passwords, off the thread that serves requests.
 *
 * bcrypt is slow on purpose: at the default cost one check takes about a
 * fifth of a second of processor time. Done on the thread that serves
 * requests, forty checks stopped the whole API for ten seconds. The native
 * library does the work on the runtime's thread pool, so every other request
 * goes on being served meanwhile. The hashes are the ones the earlier library
 * wrote: same format, nothing to migrate.
 *
 * The pool has few threads, and what does not fit waits. Waiting has a bound:
 * beyond `MAX_PENDING` checks at once a request is refused with 503, instead
 * of joining a queue that would answer it after its client has given up.
 */
export const MAX_PENDING = 64;

let pending = 0;

async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (pending >= MAX_PENDING) {
    throw new ServiceUnavailableException({
      error: 'SERVER_BUSY',
      message: 'The server is busy checking passwords. Try again in a moment.',
    });
  }
  pending += 1;
  try {
    return await work();
  } finally {
    pending -= 1;
  }
}

/** Hash `secret` at the given cost. */
export function hashPassword(secret: string, rounds: number): Promise<string> {
  return bounded(() => bcrypt.hash(secret, rounds));
}

/** Whether `secret` is what `hash` was made from. A hash that is not one is simply not matched. */
export function verifyPassword(secret: string, hash: string): Promise<boolean> {
  return bounded(() => bcrypt.compare(secret, hash));
}

/** Hash at start-up, before any request is served: the one place that may block. */
export function hashPasswordAtStartup(secret: string, rounds: number): string {
  return bcrypt.hashSync(secret, rounds);
}
