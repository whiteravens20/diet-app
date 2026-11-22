// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * The header the bundled web server writes the address of the connection it accepted into
 * (`apps/web/client-address.cjs`), over whatever a client sent in it.
 */
const CLIENT_ADDRESS_HEADER = 'x-client-address';

/** The name the web server has on the Compose network of the shipped stacks. */
const WEB_HOST = 'web';
/** How often the web server's addresses are looked up again: a container started again may have another. */
const REFRESH_MS = 30_000;
/** The least time between two lookups that a request from an address not known yet asks for. */
const RETRY_MS = 5_000;

/** Marks a request whose address the web server gave: the client's own. */
const GIVEN = Symbol('addressGivenByWebServer');

/** An address as one connection names it: IPv4 also when written as IPv6 (`::ffff:203.0.113.7`), without a zone. */
function plain(address: string | undefined): string | null {
  if (!address) return null;
  const bare = address.split('%')[0]!;
  const v4 = bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare;
  return isIP(v4) === 0 ? null : v4.toLowerCase();
}

/**
 * The addresses no client is known by, because many may stand behind one: private networks (the Compose network's
 * gateway, a proxy's container, a home network behind its router), the loopback, link-local and unique local ranges,
 * and the space carrier-grade NAT shares out. A web server published on the loopback, as both shipped Compose files
 * publish it, or behind a proxy, accepts every connection from such an address.
 */
const SHARED_ADDRESSES = (() => {
  const shared = new BlockList();
  const v4: [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
  ];
  const v6: [string, number][] = [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
  ];
  for (const [network, prefix] of v4) shared.addSubnet(network, prefix, 'ipv4');
  for (const [network, prefix] of v6) shared.addSubnet(network, prefix, 'ipv6');
  return shared;
})();

/** Whether an address (as `plain` gives it) is a public one, a client's own: none of `SHARED_ADDRESSES`. */
const isPublic = (address: string): boolean =>
  !SHARED_ADDRESSES.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

/**
 * The bundled web server, as the API knows it on the Compose network: the addresses its name
 * resolves to. A request whose connection comes from one of them was handed on by the web server,
 * which says in its own header whose connection it accepted. Looked up at start and every
 * `REFRESH_MS`; where the name resolves to nothing (no Compose network, another name) nothing is
 * known, and no request is believed.
 */
@Injectable()
export class WebServer implements OnModuleInit, OnModuleDestroy {
  private addresses = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private lastLookup = 0;

  /** How the web server's name is resolved; replaceable in a test. */
  resolve: () => Promise<string[]> = async () =>
    (await lookup(WEB_HOST, { all: true })).map((found) => found.address);

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Look the web server's addresses up again; a name that resolves to nothing leaves none. */
  async refresh(): Promise<void> {
    this.lastLookup = Date.now();
    try {
      this.addresses = new Set(
        (await this.resolve()).map((address) => plain(address)).filter((one) => one !== null),
      );
    } catch {
      this.addresses = new Set();
    }
  }

  /** Whether a connection from `address` is the web server's. One from an address not known yet asks for a lookup. */
  isPeer(address: string | undefined): boolean {
    const peer = plain(address);
    if (peer === null) return false;
    if (this.addresses.has(peer)) return true;
    if (Date.now() - this.lastLookup > RETRY_MS) void this.refresh();
    return false;
  }
}

/**
 * Where `TRUST_PROXY` is off: a request the web server handed on carries, in the web server's own
 * header, the address of the connection it accepted, and where that is a public address, a
 * client's own, `req.ip` becomes it. A shared one (`SHARED_ADDRESSES`) says only that a proxy, the
 * host or a router stands before the web server, and is not taken. Any other request, a header sent
 * by anyone else included, keeps the address of its connection.
 */
export function takeClientAddress(webServer: WebServer) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers[CLIENT_ADDRESS_HEADER];
    const given = typeof header === 'string' ? plain(header.trim()) : null;
    if (given !== null && isPublic(given) && webServer.isPeer(req.socket.remoteAddress)) {
      Object.defineProperty(req, 'ip', { value: given, configurable: true, enumerable: true });
      (req as unknown as Record<symbol, boolean>)[GIVEN] = true;
    }
    next();
  };
}

/** Whether a request's address is the one the web server accepted the connection from. */
export function addressGiven(req: unknown): boolean {
  return (
    typeof req === 'object' && req !== null && (req as Record<symbol, unknown>)[GIVEN] === true
  );
}
