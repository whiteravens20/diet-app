// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * SSRF guard + operator policy for user-supplied Ollama base URLs.
 *
 * Unlike the other providers (fixed public API hosts), the Ollama adapter
 * dials a base URL that a user can supply — via the `POST /ai/test` probe and a
 * persisted BYOK `AiProviderConfig.baseUrl`. Without a guard an authenticated
 * user could aim it at an internal address (`http://169.254.169.254`,
 * `http://10.0.0.1:9090`, a sibling container) and use the API as an SSRF relay.
 *
 * The operator chooses the policy (`OLLAMA_USER_POLICY`):
 *  - `off`       — users may not configure their own Ollama at all.
 *  - `allowlist` — (default) only `OLLAMA_BASE_URL`'s host and `OLLAMA_ALLOWED_HOSTS`.
 *  - `public`    — any host EXCEPT internal/private/loopback/link-local ones, so
 *                  a user's own publicly-reachable Ollama works while the server
 *                  still cannot be steered onto the operator's internal network.
 *
 * Under `allowlist` and `public` a user may name the operator's own
 * `OLLAMA_BASE_URL` host; calls made that way are the operator's to pay for
 * and count against the monthly allowance like any other.
 *
 * A URL only names a host. Under `public` the name is checked here by its
 * shape, and the addresses it resolves to are checked again when the
 * connection is made (see `ollama-http.ts`), so a public name that points at
 * an internal address is refused as well.
 */
import { BlockList, isIP } from 'node:net';
import type { OllamaUserPolicy } from '@diet-app/shared';

export type { OllamaUserPolicy };

export type OllamaUrlErrorCode = 'OLLAMA_USER_DISABLED' | 'OLLAMA_HOST_NOT_ALLOWED';

export class OllamaUrlError extends Error {
  constructor(
    message: string,
    readonly code: OllamaUrlErrorCode = 'OLLAMA_HOST_NOT_ALLOWED',
  ) {
    super(message);
    this.name = 'OllamaUrlError';
  }
}

export interface OllamaGuardOptions {
  policy: OllamaUserPolicy;
  /** The operator-configured default. */
  defaultBaseUrl: string;
  /** `OLLAMA_ALLOWED_HOSTS` entries (host or host:port). Only used in `allowlist`. */
  allowedHosts: string[];
}

/** An address a user supplied, and the terms on which it may be dialled. */
export interface OllamaTarget {
  url: URL;
  /** The operator's own instance: calls to it are the operator's to pay for. */
  operatorHost: boolean;
  /** Connect only if every address the host resolves to is a public one. */
  publicOnly: boolean;
}

interface Allowlist {
  hostsWithPort: Set<string>;
  bareHosts: Set<string>;
}

function buildAllowlist(allowedHosts: string[]): Allowlist {
  const hostsWithPort = new Set<string>();
  const bareHosts = new Set<string>();
  for (const raw of allowedHosts) {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (/^https?:\/\//.test(entry)) {
      try {
        hostsWithPort.add(new URL(entry).host);
      } catch {
        /* skip malformed */
      }
      continue;
    }
    if (entry.includes(':')) hostsWithPort.add(entry);
    else bareHosts.add(entry);
  }
  return { hostsWithPort, bareHosts };
}

/**
 * The host of a URL as it is compared: lower case, and without the trailing
 * dot of a fully qualified name, which names the same host (`postgres.` is
 * `postgres`).
 */
function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

/** Host and port as an allowlist entry writes them: the port only when it is not the default. */
function hostWithPortOf(url: URL): string {
  return url.port ? `${hostnameOf(url)}:${url.port}` : hostnameOf(url);
}

/** Host and the port a connection would go to. */
function endpointOf(url: URL): string {
  return `${hostnameOf(url)}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

/** True when `rawUrl` names the host and port of the operator's own Ollama. */
export function isOperatorOllama(rawUrl: string, defaultBaseUrl: string): boolean {
  try {
    return endpointOf(new URL(rawUrl)) === endpointOf(new URL(defaultBaseUrl));
  } catch {
    return false;
  }
}

/** Every range that is not a public unicast address. */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  // Unspecified, loopback and IPv4-compatible addresses. The forms that carry
  // an IPv4 address inside an IPv6 one are refused whole: nobody's Ollama is
  // reached through them, and each is a way to spell an internal address.
  ['::', 96],
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/**
 * True for an IP address that is public. An IPv4-mapped IPv6 address
 * (`::ffff:10.0.0.1`) is judged by the IPv4 address it carries.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** True for hosts that should never be reachable in `public` mode. */
function isInternalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(h) !== 0) return !isPublicAddress(h);
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  // A single-label hostname (no dot) is a container / service name on an
  // internal network (e.g. `ollama`, `postgres`) — deny in public mode.
  return !h.includes('.');
}

/**
 * Validate a user-supplied Ollama base URL against the operator policy.
 * Returns where and how it may be dialled; throws {@link OllamaUrlError}
 * otherwise. The operator's own configuration is not a user's and does not
 * pass through here.
 */
export function assertAllowedOllamaUrl(rawUrl: string, opts: OllamaGuardOptions): OllamaTarget {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OllamaUrlError(`not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OllamaUrlError(`unsupported protocol "${url.protocol}" — use http(s)`);
  }

  if (opts.policy === 'off') {
    throw new OllamaUrlError(
      'User-configured Ollama is disabled on this instance.',
      'OLLAMA_USER_DISABLED',
    );
  }
  if (isOperatorOllama(rawUrl, opts.defaultBaseUrl)) {
    return { url, operatorHost: true, publicOnly: false };
  }

  const hostname = hostnameOf(url);
  if (opts.policy === 'public') {
    if (isInternalHost(hostname)) {
      throw new OllamaUrlError(
        `Ollama host "${url.host}" is an internal/private address and is not allowed.`,
      );
    }
    return { url, operatorHost: false, publicOnly: true };
  }

  const allow = buildAllowlist(opts.allowedHosts);
  if (allow.hostsWithPort.has(hostWithPortOf(url)) || allow.bareHosts.has(hostname)) {
    return { url, operatorHost: false, publicOnly: false };
  }
  throw new OllamaUrlError(
    `Ollama host "${url.host}" is not allowed. It must match OLLAMA_BASE_URL ` +
      'or an entry in OLLAMA_ALLOWED_HOSTS.',
  );
}

/** Parse the comma-separated `OLLAMA_ALLOWED_HOSTS` env value into a list. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
