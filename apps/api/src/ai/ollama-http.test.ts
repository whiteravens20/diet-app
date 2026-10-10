// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ollamaRequest, OllamaRequestError, type OllamaRequest, type Resolver } from './ollama-http.js';

/** What the stub server does with the next request; each test sets it. */
let respond: (path: string, body: string, res: ServerResponse) => void;
let port: number;
let hits = 0;

const server = createServer((req, res) => {
  hits += 1;
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => respond(req.url ?? '', Buffer.concat(chunks).toString('utf8'), res));
});

beforeAll(async () => {
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
});

const request = (overrides: Partial<OllamaRequest> = {}): OllamaRequest => ({
  method: 'GET',
  timeoutMs: 3_000,
  maxBytes: 10_000,
  publicOnly: false,
  ...overrides,
});

/** A resolver that answers from a table instead of the network. */
const resolver =
  (table: Record<string, string[]>): Resolver =>
  (hostname, _options, callback) => {
    const addresses = table[hostname];
    if (!addresses) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
      return;
    }
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  };

async function failure(call: Promise<unknown>): Promise<OllamaRequestError> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(OllamaRequestError);
    return err as OllamaRequestError;
  }
  throw new Error('the request was expected to fail');
}

describe('ollamaRequest', () => {
  it('sends a JSON body and returns the status and the text of the answer', async () => {
    let seen = '';
    respond = (path, body, res) => {
      seen = `${path} ${body}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    };

    const res = await ollamaRequest(`http://127.0.0.1:${port}/api/chat`, request({ method: 'POST', body: { model: 'm' } }));

    expect(res).toMatchObject({ status: 200, text: '{"ok":true}' });
    expect(seen).toBe('/api/chat {"model":"m"}');
  });

  it('returns an error status as it is, for the caller to judge', async () => {
    respond = (_path, _body, res) => {
      res.writeHead(404, 'Not Found');
      res.end('no such model');
    };
    await expect(ollamaRequest(`http://127.0.0.1:${port}/api/tags`, request())).resolves.toMatchObject({
      status: 404,
      statusText: 'Not Found',
      text: 'no such model',
    });
  });

  it('does not follow a redirect', async () => {
    respond = (path, _body, res) => {
      if (path === '/api/tags') {
        res.writeHead(307, { Location: `http://127.0.0.1:${port}/internal` });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('the internal page');
    };
    hits = 0;

    const res = await ollamaRequest(`http://127.0.0.1:${port}/api/tags`, request());

    expect(res.status).toBe(307);
    expect(res.text).toBe('');
    // The place the redirect pointed at was never asked.
    expect(hits).toBe(1);
  });

  it('stops reading a body that grows past the limit', async () => {
    respond = (_path, _body, res) => {
      res.writeHead(200);
      const more = (): void => {
        if (res.destroyed) return;
        res.write('x'.repeat(4_000), () => setImmediate(more));
      };
      more();
    };

    const flood = await failure(ollamaRequest(`http://127.0.0.1:${port}/`, request({ maxBytes: 10_000 })));

    expect(flood.failure).toBe('too_large');
  });

  it('gives up after the deadline, whether the answer never starts or never ends', async () => {
    respond = () => {
      // Never answers.
    };
    expect((await failure(ollamaRequest(`http://127.0.0.1:${port}/`, request({ timeoutMs: 150 })))).failure).toBe('timeout');

    respond = (_path, _body, res) => {
      res.writeHead(200);
      res.write('half an ans');
    };
    expect((await failure(ollamaRequest(`http://127.0.0.1:${port}/`, request({ timeoutMs: 150 })))).failure).toBe('timeout');
  });

  it('reports a host that cannot be reached as a network failure', async () => {
    expect((await failure(ollamaRequest('http://127.0.0.1:1/', request()))).failure).toBe('network');
  });

  describe('when only a public address may be dialled', () => {
    const names = resolver({
      'looks-public.example': ['127.0.0.1'],
      'two-faced.example': ['93.184.216.34', '10.0.0.7'],
      'mapped.example': ['::ffff:127.0.0.1'],
      'nowhere.example': [],
    });

    it('reaches a loopback name when no check is asked for, and refuses the same name when it is', async () => {
      respond = (_path, _body, res) => {
        res.writeHead(200);
        res.end('reached');
      };
      const open = await ollamaRequest(`http://localhost:${port}/`, request({ publicOnly: false }));
      expect(open.text).toBe('reached');

      hits = 0;
      const refused = await failure(ollamaRequest(`http://localhost:${port}/`, request({ publicOnly: true })));
      expect(refused.failure).toBe('address_not_public');
      expect(hits).toBe(0);
    });

    it.each(['looks-public.example', 'two-faced.example', 'mapped.example', 'nowhere.example'])(
      'refuses %s, which resolves to an address that is not public, without connecting',
      async (name) => {
        respond = (_path, _body, res) => {
          res.writeHead(200);
          res.end('reached');
        };
        hits = 0;

        const refused = await failure(
          ollamaRequest(`http://${name}:${port}/api/tags`, request({ publicOnly: true }), names),
        );

        expect(refused.failure).toBe('address_not_public');
        expect(hits).toBe(0);
      },
    );

    it('reports a name that does not resolve as a network failure', async () => {
      const unknown = await failure(
        ollamaRequest(`http://no-such-host.example:${port}/`, request({ publicOnly: true }), names),
      );
      expect(unknown.failure).toBe('network');
    });
  });
});
