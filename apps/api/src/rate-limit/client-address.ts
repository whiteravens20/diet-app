// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { isIP } from 'node:net';
import { normalizeIp } from '@nestjs/throttler';

/**
 * The client a request is counted against, as far as its address says who
 * that is.
 *
 * An IPv4 address is one client, also when it arrives written as IPv6
 * (`::ffff:203.0.113.7`). An IPv6 client is its /64 network: one machine is
 * handed that many addresses, and counted one by one it would be a new client
 * with every request. Whatever is not an address is one client, `unknown`:
 * behind a proxy that is set up wrongly anything can arrive in its place, and
 * none of it is kept or logged.
 */
export function countedAddress(address: unknown): string {
  // A zone (`fe80::1%eth0`) says which interface, not which client.
  if (typeof address !== 'string' || isIP(address.split('%')[0]!) === 0) return 'unknown';
  return normalizeIp(address);
}
