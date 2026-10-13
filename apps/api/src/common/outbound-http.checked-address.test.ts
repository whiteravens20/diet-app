// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createServer } from 'node:http';
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, type AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { outboundRequest, OutboundRequestError, type OutboundRequest, type Resolver } from './outbound-http.js';

// A test cannot dial a public address. Here the loopback address, where the
// stub server listens, stands in for one, and 10.0.0.7 for an address that is
// not public. What counts as public is tested by itself (`public-address.test.ts`).
vi.mock('./public-address.js', () => ({ isPublicAddress: (address: string) => address !== '10.0.0.7' }));

let port: number;
let hits = 0;

const server = createServer((_req, res) => {
  hits += 1;
  res.writeHead(200);
  res.end('reached');
});

beforeAll(async () => {
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
});

const publicOnly: OutboundRequest = { method: 'GET', timeoutMs: 3_000, maxBytes: 10_000, publicOnly: true };

/** A resolver that gives one answer after another, the last one for good, and counts how often it was asked. */
function answering(...answers: string[][]): { resolve: Resolver; asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    resolve: (_hostname, _options, callback) => {
      const addresses = answers[Math.min(asked, answers.length - 1)]!;
      asked += 1;
      callback(
        null,
        addresses.map((address) => ({ address, family: 4 })),
      );
    },
  };
}

describe('a name that resolves to a public address, when only such an address may be dialled', () => {
  const before = getDefaultAutoSelectFamily();

  afterEach(() => {
    setDefaultAutoSelectFamily(before);
  });

  // The socket asks for every address of a name when it may try one after another, and for one address when it may not.
  it.each([
    ['every address of the name', true],
    ['one address of the name', false],
  ])('is dialled where it was checked, when the socket asks for %s', async (_name, all) => {
    setDefaultAutoSelectFamily(all);
    const name = answering(['127.0.0.1']);
    hits = 0;

    const answer = await outboundRequest(`http://models.example:${port}/api/tags`, publicOnly, name.resolve);

    expect(answer).toMatchObject({ status: 200, text: 'reached' });
    expect(hits).toBe(1);
    expect(name.asked()).toBe(1);
  });

  it('is resolved once: a name that would answer with another address the next time is not asked again', async () => {
    const name = answering(['127.0.0.1'], ['10.0.0.7']);
    hits = 0;

    const answer = await outboundRequest(`http://turning.example:${port}/api/tags`, publicOnly, name.resolve);

    expect(answer.text).toBe('reached');
    expect(name.asked()).toBe(1);
  });

  it('is not dialled when one of its addresses is not public, whichever comes first', async () => {
    hits = 0;

    for (const addresses of [
      ['127.0.0.1', '10.0.0.7'],
      ['10.0.0.7', '127.0.0.1'],
    ]) {
      const refused = await outboundRequest(`http://two-faced.example:${port}/api/tags`, publicOnly, answering(addresses).resolve).catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(OutboundRequestError);
      expect((refused as OutboundRequestError).failure).toBe('address_not_public');
    }
    expect(hits).toBe(0);
  });
});
