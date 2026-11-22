// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { addressGiven, takeClientAddress, WebServer } from './web-server.js';

/** The web server as the API finds it on the Compose network. */
const theWebServer = (): WebServer => {
  const web = new WebServer();
  web.isPeer = (address) => address === '172.19.0.7';
  return web;
};

/** A request the web server handed on, its header naming the connection it accepted. */
const handedOn = (accepted: string, from = '172.19.0.7') => {
  const req = {
    headers: { 'x-client-address': accepted },
    socket: { remoteAddress: from },
    ip: from,
  } as unknown as Request;
  takeClientAddress(theWebServer())(req, {} as Response, () => undefined);
  return req;
};

describe("the bundled web server's word for whose connection it accepted", () => {
  it.each(['203.0.113.7', '198.51.100.9', '::ffff:198.51.100.9', '2001:db8::7'])(
    'is taken for a public address, %s, a client of its own',
    (accepted) => {
      const req = handedOn(accepted);

      expect(addressGiven(req)).toBe(true);
      expect(req.ip).toBe(accepted.replace('::ffff:', ''));
    },
  );

  it.each([
    [
      'the Compose network’s gateway, where a loopback port and a proxy on the host are',
      '172.19.0.1',
    ],
    ['a proxy’s container', '172.20.0.5'],
    ['a home network behind its router', '192.168.1.20'],
    ['another private network', '10.0.0.5'],
    ['the loopback', '127.0.0.1'],
    ['a link-local address', '169.254.3.4'],
    ['carrier-grade NAT', '100.64.0.9'],
    ['the IPv6 loopback', '::1'],
    ['a unique local IPv6 address', 'fd00::5'],
    ['a link-local IPv6 address', 'fe80::1'],
    ['a private address written as IPv6', '::ffff:172.19.0.1'],
  ])('is not taken for %s (%s): many clients may stand behind it', (_where, accepted) => {
    const req = handedOn(accepted);

    expect(addressGiven(req)).toBe(false);
    expect(req.ip).toBe('172.19.0.7');
  });

  it('is not taken from anyone but the web server', () => {
    const req = handedOn('203.0.113.7', '172.19.0.9');

    expect(addressGiven(req)).toBe(false);
    expect(req.ip).toBe('172.19.0.9');
  });
});
