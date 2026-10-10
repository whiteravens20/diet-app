// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { AiTestService } from './ai-test.service.js';

/** What the stub Ollama server does with the next request; each test sets it. */
let respond: (path: string, res: ServerResponse) => void;
let operatorUrl: string;
let hits = 0;

const server = createServer((req, res) => {
  hits += 1;
  respond(req.url ?? '', res);
});

beforeAll(async () => {
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  operatorUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
});

const service = (env: Partial<Env> = {}): AiTestService => {
  const values: Partial<Env> = {
    OLLAMA_BASE_URL: operatorUrl,
    OLLAMA_USER_POLICY: 'allowlist',
    OLLAMA_ALLOWED_HOSTS: '',
    ...env,
  };
  return new AiTestService({ get: (key: keyof Env) => values[key] } as unknown as ConfigService<Env, true>);
};

const tags = (names: string[]) => (_path: string, res: ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ models: names.map((name) => ({ name })) }));
};

describe('probing an Ollama server', () => {
  it('lists the models of an allowed server, sorted', async () => {
    respond = tags(['qwen2.5:14b', 'llama3.1:8b']);

    await expect(service().test({ provider: 'ollama', baseUrl: operatorUrl })).resolves.toEqual({
      ok: true,
      models: ['llama3.1:8b', 'qwen2.5:14b'],
      error: null,
    });
  });

  it("probes the operator's own server when no address is given, whatever users are allowed", async () => {
    respond = tags(['llama3.1:8b']);

    const result = await service({ OLLAMA_USER_POLICY: 'off' }).test({ provider: 'ollama' });

    expect(result).toMatchObject({ ok: true, models: ['llama3.1:8b'] });
  });

  it.each([
    ['an address that is not on the list', 'http://169.254.169.254', {}, 'not allowed'],
    ['any address when users may not configure Ollama', 'http://gpu-box:11434', { OLLAMA_USER_POLICY: 'off' as const }, 'disabled'],
    ['an internal name written with a trailing dot', 'http://postgres.:5432', { OLLAMA_USER_POLICY: 'public' as const }, 'internal'],
  ])('refuses %s without making a request', async (_name, baseUrl, env, reason) => {
    respond = tags(['unreachable']);
    hits = 0;

    const result = await service(env).test({ provider: 'ollama', baseUrl });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(reason);
    expect(hits).toBe(0);
  });

  it('reports an error status without following a redirect', async () => {
    respond = (path, res) => {
      if (path === '/api/tags') {
        res.writeHead(307, { Location: `${operatorUrl}/elsewhere` });
        res.end();
        return;
      }
      tags(['behind-the-redirect'])(path, res);
    };
    hits = 0;

    const result = await service().test({ provider: 'ollama', baseUrl: operatorUrl });

    expect(result).toEqual({ ok: false, models: [], error: 'HTTP 307 Temporary Redirect' });
    expect(hits).toBe(1);
  });

  it('does not repeat what a host that is not an Ollama server sent', async () => {
    respond = (_path, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>internal dashboard, build 4711</html>');
    };

    const result = await service().test({ provider: 'ollama', baseUrl: operatorUrl });

    expect(result).toEqual({ ok: false, models: [], error: 'The host answered, but not as an Ollama server.' });
  });

  it('reports a server that cannot be reached', async () => {
    const result = await service({ OLLAMA_BASE_URL: 'http://127.0.0.1:1' }).test({ provider: 'ollama' });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('probing a provider that needs a key', () => {
  it.each(['openai', 'openrouter', 'anthropic'] as const)('asks for the key of %s before calling out', async (provider) => {
    const result = await service().test({ provider, model: 'some-model' });
    expect(result).toEqual({ ok: false, models: [], error: 'API key required.' });
  });

  it('asks for a model to probe anthropic with', async () => {
    const result = await service().test({ provider: 'anthropic', apiKey: 'key' });
    expect(result.error).toContain('Model id required');
  });
});
