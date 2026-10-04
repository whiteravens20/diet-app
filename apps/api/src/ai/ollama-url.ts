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
 * The operator's own `OLLAMA_BASE_URL` host is always trusted under every policy.
 *
 * NOTE: `public` mode classifies by URL host literal/shape. A public DNS name
 * that resolves to a private IP (DNS rebinding) is not caught here — closing
 * that requires resolve-and-pin at dial time. Tracked in the accepted-risk
 * register; `allowlist` (the default) is not affected.
 */
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
  /** The operator-configured default — its host is always trusted. */
  defaultBaseUrl: string;
  /** `OLLAMA_ALLOWED_HOSTS` entries (host or host:port). Only used in `allowlist`. */
  allowedHosts: string[];
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

/** Host of the operator default, lower-cased, or '' if unparseable. */
function defaultHost(defaultBaseUrl: string): string {
  try {
    return new URL(defaultBaseUrl).host.toLowerCase();
  } catch {
    return '';
  }
}

function isPrivateIpv4(ip: string): boolean {
  const o = ip.split('.').map((p) => Number(p));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → deny (treat as internal)
  }
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  if (h.startsWith('fe80')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique-local fc00::/7
  // IPv4-mapped, dotted form: ::ffff:10.0.0.1
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted) return isPrivateIpv4(dotted[1]);
  // IPv4-mapped, hex form (URL normalises ::ffff:10.0.0.1 → ::ffff:a00:1).
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIpv4(v4);
  }
  return false;
}

/** True for hosts that should never be reachable in `public` mode. */
function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
  const isIpv6 = h.includes(':');
  // A single-label hostname (no dot) is a container / service name on an
  // internal network (e.g. `ollama`, `postgres`) — deny in public mode.
  if (!isIpv4 && !isIpv6 && !h.includes('.')) return true;
  if (isIpv4) return isPrivateIpv4(h);
  if (isIpv6) return isPrivateIpv6(h);
  return false;
}

/**
 * Validate a user-supplied Ollama base URL against the operator policy.
 * Returns the parsed URL on success; throws {@link OllamaUrlError} otherwise.
 */
export function assertAllowedOllamaUrl(rawUrl: string, opts: OllamaGuardOptions): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OllamaUrlError(`not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OllamaUrlError(`unsupported protocol "${url.protocol}" — use http(s)`);
  }

  const hostWithPort = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();

  // The operator's own configured Ollama is trusted under every policy.
  if (hostWithPort === defaultHost(opts.defaultBaseUrl)) return url;

  switch (opts.policy) {
    case 'off':
      throw new OllamaUrlError(
        'User-configured Ollama is disabled on this instance.',
        'OLLAMA_USER_DISABLED',
      );
    case 'public':
      if (isInternalHost(hostname)) {
        throw new OllamaUrlError(
          `Ollama host "${url.host}" is an internal/private address and is not allowed.`,
        );
      }
      return url;
    case 'allowlist':
    default: {
      const allow = buildAllowlist(opts.allowedHosts);
      if (allow.hostsWithPort.has(hostWithPort) || allow.bareHosts.has(hostname)) return url;
      throw new OllamaUrlError(
        `Ollama host "${url.host}" is not allowed. It must match OLLAMA_BASE_URL ` +
          'or an entry in OLLAMA_ALLOWED_HOSTS.',
      );
    }
  }
}

/** Parse the comma-separated `OLLAMA_ALLOWED_HOSTS` env value into a list. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
