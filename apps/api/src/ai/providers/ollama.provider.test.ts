// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiProviderError, type CompletionOptions } from '../provider.interface.js';
import { OllamaProvider } from './ollama.provider.js';

/** What the stub server does with the next request; each test sets it. */
let respond: (body: string, res: ServerResponse) => void;
let baseUrl: string;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => respond(Buffer.concat(chunks).toString('utf8'), res));
});

beforeAll(async () => {
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
});

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const chat = (opts: Partial<CompletionOptions> = {}) =>
  new OllamaProvider().chat([{ role: 'user', content: 'hello' }], { model: 'test-model', baseUrl, ...opts });

async function failure(call: Promise<unknown>): Promise<AiProviderError> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(AiProviderError);
    return err as AiProviderError;
  }
  throw new Error('the call was expected to fail');
}

describe('OllamaProvider', () => {
  it('sends the model and the messages and returns the reply with its token counts', async () => {
    let sent: Record<string, unknown> = {};
    respond = (body, res) => {
      sent = JSON.parse(body) as Record<string, unknown>;
      json(res, 200, { message: { content: 'hi there' }, prompt_eval_count: 11, eval_count: 3 });
    };

    await expect(chat()).resolves.toEqual({ text: 'hi there', promptTokens: 11, outputTokens: 3 });
    expect(sent).toMatchObject({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
    expect(sent).not.toHaveProperty('format');
  });

  it('asks for a JSON object when the caller wants one', async () => {
    let sent: Record<string, unknown> = {};
    respond = (body, res) => {
      sent = JSON.parse(body) as Record<string, unknown>;
      json(res, 200, { message: { content: '{}' } });
    };

    await expect(chat({ json: true })).resolves.toEqual({ text: '{}', promptTokens: 0, outputTokens: 0 });
    expect(sent.format).toBe('json');
  });

  it('reports a server error as worth another attempt and a client error as final', async () => {
    respond = (_body, res) => json(res, 503, { error: 'model is loading' });
    const loading = await failure(chat());
    expect(loading.retryable).toBe(true);
    expect(loading.message).toContain('503');
    expect(loading.message).toContain('model is loading');

    respond = (_body, res) => json(res, 404, { error: 'model not found' });
    const missing = await failure(chat());
    expect(missing.retryable).toBe(false);
    expect(missing.timedOut).toBe(false);
  });

  it('reports a host that does not answer as worth another attempt', async () => {
    const refused = await failure(chat({ baseUrl: 'http://127.0.0.1:1' }));
    expect(refused.retryable).toBe(true);
    expect(refused.timedOut).toBe(false);
  });

  it('gives up on a body that is not JSON', async () => {
    respond = (_body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>a login page</html>');
    };
    expect((await failure(chat())).timedOut).toBe(false);
  });

  it('stops reading a response that never ends', async () => {
    // A megabyte at a time, for as long as the client keeps the connection open.
    const megabyte = 'x'.repeat(1_000_000);
    let written = 0;
    respond = (_body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"message":{"content":"');
      const more = (): void => {
        if (res.destroyed) return;
        written += megabyte.length;
        res.write(megabyte, () => setImmediate(more));
      };
      more();
    };

    const flood = await failure(chat());
    expect(flood.retryable).toBe(false);
    expect(flood.timedOut).toBe(false);
    expect(flood.message).toContain('more than');
    // The server was cut off after a few megabytes, not left to fill the memory.
    expect(written).toBeLessThan(50_000_000);
  });
});
