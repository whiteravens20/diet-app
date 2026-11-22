// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';

const original = http.Server.prototype.emit;
createRequire(import.meta.url)('../../client-address.cjs');

afterAll(() => {
  http.Server.prototype.emit = original;
});

describe('the address the web server hands on', () => {
  it('is that of the connection it accepted, whatever the client wrote in the header', async () => {
    const server = http.createServer((req, res) => {
      res.end(String(req.headers['x-client-address']));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      const forged = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'x-client-address': '203.0.113.9' },
      });
      expect(await forged.text()).toBe('127.0.0.1');
      const plain = await fetch(`http://127.0.0.1:${port}/`);
      expect(await plain.text()).toBe('127.0.0.1');
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
