// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { isIP } from 'node:net';

/**
 * Whose word the API takes for a client's address.
 *
 * A request reaches the API through the web server, and usually through a
 * reverse proxy in front of that, so the connection the API sees is never the
 * client's own. The client's address arrives in `X-Forwarded-For`, a header
 * anyone can write. It may be believed only as far as it was written by a
 * proxy the operator runs:
 *
 *  - `false`: believe nothing. The address is that of the connection.
 *  - a number: that many reverse proxies stand in front and each adds the
 *    address it saw to the header. The web server is not one of them: it
 *    passes the header on as it arrives and writes nothing. One Traefik or
 *    nginx is 1, whether it sends `/api` to the API itself or to the web
 *    server. A number that is too high is the dangerous mistake: the API
 *    then reads an address further left than any proxy wrote.
 *  - a list: the addresses or networks of the proxies themselves.
 *
 * The web server passes the header on as it arrives, so the setting is only
 * safe when a reverse proxy in front of it overwrites or appends to it and the
 * web port is not reachable around that proxy.
 */
export type TrustProxy = false | number | string[];

const NAMED = ['loopback', 'linklocal', 'uniquelocal'];

/** Parse `TRUST_PROXY`. Throws with what is wrong when it is none of the forms above. */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'false' || value === 'off' || value === '0') return false;
  if (value === 'true') {
    throw new Error('"true" would believe an address any client writes; give the number of proxies in front of the API, or their addresses.');
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 10) throw new Error('more than 10 proxies in a row is not a deployment; give the number of proxies in front of the API.');
    return hops;
  }
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (NAMED.includes(entry)) continue;
    const [address, prefix, ...rest] = entry.split('/');
    const family = isIP(address ?? '');
    const bits = prefix === undefined ? null : Number(prefix);
    const prefixOk = bits === null || (/^\d+$/.test(prefix!) && bits >= 0 && bits <= (family === 4 ? 32 : 128));
    if (family === 0 || rest.length > 0 || !prefixOk) {
      throw new Error(`"${entry}" is neither an address, a network (10.0.0.0/8) nor one of ${NAMED.join(', ')}.`);
    }
  }
  return entries;
}

/**
 * One line for the boot log. `behindProxy` says that a proxy is known to stand
 * in front: with the setting off that is a warning, because the address the
 * API then counts against is the proxy's.
 */
export function describeTrustProxy(setting: TrustProxy, behindProxy = false): string {
  if (setting === false) {
    return behindProxy
      ? '! client address: that of the proxy for every visitor alike. The public origin is https, so a proxy stands in front, and TRUST_PROXY is off: limits by address cannot tell visitors apart until it is set'
      : 'client address: that of the connection (TRUST_PROXY is off; behind the web server every client then counts as one)';
  }
  if (typeof setting === 'number') return `client address: from X-Forwarded-For, written by ${setting} trusted ${setting === 1 ? 'proxy' : 'proxies'}`;
  return `client address: from X-Forwarded-For, written by proxies at ${setting.join(', ')}`;
}
