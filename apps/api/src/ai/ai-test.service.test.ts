// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  return new AiTestService({ get: (key: keyof Env) => values[key] } as unknown as ConfigService<
    Env,
    true
  >);
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
      noRetentionProviders: null,
    });
  });

  it("probes the operator's own server when no address is given, whatever users are allowed", async () => {
    respond = tags(['llama3.1:8b']);

    const result = await service({ OLLAMA_USER_POLICY: 'off' }).test({ provider: 'ollama' });

    expect(result).toMatchObject({ ok: true, models: ['llama3.1:8b'] });
  });

  it.each([
    ['an address that is not on the list', 'http://169.254.169.254', {}, 'not allowed'],
    [
      'any address when users may not configure Ollama',
      'http://gpu-box:11434',
      { OLLAMA_USER_POLICY: 'off' as const },
      'disabled',
    ],
    [
      'an internal name written with a trailing dot',
      'http://postgres.:5432',
      { OLLAMA_USER_POLICY: 'public' as const },
      'internal',
    ],
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

    expect(result).toEqual({
      ok: false,
      models: [],
      error: 'HTTP 307 Temporary Redirect',
      noRetentionProviders: null,
    });
    expect(hits).toBe(1);
  });

  it('does not repeat what a host that is not an Ollama server sent', async () => {
    respond = (_path, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>internal dashboard, build 4711</html>');
    };

    const result = await service().test({ provider: 'ollama', baseUrl: operatorUrl });

    expect(result).toEqual({
      ok: false,
      models: [],
      error: 'The host answered, but not as an Ollama server.',
      noRetentionProviders: null,
    });
  });

  it('reports a server that cannot be reached', async () => {
    const result = await service({ OLLAMA_BASE_URL: 'http://127.0.0.1:1' }).test({
      provider: 'ollama',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('probing a provider that needs a key', () => {
  it.each(['openai', 'openrouter', 'anthropic'] as const)(
    'asks for the key of %s before calling out',
    async (provider) => {
      const result = await service().test({ provider, model: 'some-model' });
      expect(result).toEqual({
        ok: false,
        models: [],
        error: 'API key required.',
        noRetentionProviders: null,
      });
    },
  );

  it('asks for a model to probe anthropic with', async () => {
    const result = await service().test({ provider: 'anthropic', apiKey: 'key' });
    expect(result.error).toContain('Model id required');
  });
});

describe('the providers of a model on OpenRouter that keep no data', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const LIST = 'https://openrouter.ai/api/v1/endpoints/zdr';
  /** Rows as OpenRouter's list had them on 2026-11-19, a few fields of each. */
  const endpoints = [
    { model_id: 'openai/gpt-6-luna', provider_name: 'Azure', tag: 'azure' },
    { model_id: 'openai/gpt-6-luna-pro', provider_name: 'Azure', tag: 'azure' },
    { model_id: 'some/open-model', provider_name: 'Together', tag: 'together' },
    { model_id: 'some/open-model', provider_name: 'DeepInfra', tag: 'deepinfra/fp8' },
    { model_id: 'some/open-model', provider_name: 'DeepInfra', tag: 'deepinfra/bf16' },
  ];
  /** Answers the list as given, and a list of models to the key's probe; counts what was asked. */
  function openRouter(list: () => Response) {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      asked.push(String(url));
      if (String(url) === LIST) return list();
      return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-6-luna' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return asked;
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const asking = (more: Record<string, unknown> = {}) => ({
    provider: 'openrouter' as const,
    apiKey: 'sk-or-test',
    model: 'openai/gpt-6-luna',
    dataPolicy: 'no_retention' as const,
    ...more,
  });

  it('are named, each once and in order, for the model and the choice of no retention', async () => {
    openRouter(() => json({ data: endpoints }));

    expect((await service().test(asking())).noRetentionProviders).toEqual(['Azure']);
    expect(
      (await service().test(asking({ model: 'some/open-model' }))).noRetentionProviders,
    ).toEqual(['DeepInfra', 'Together']);
  });

  it('are none for a model that has no such provider, which OpenRouter would refuse', async () => {
    openRouter(() => json({ data: endpoints }));

    const result = await service().test(asking({ model: 'nobody/keeps-everything' }));

    expect(result).toMatchObject({ ok: true, noRetentionProviders: [] });
  });

  it('are named whatever the key, which is tested on its own', async () => {
    openRouter(() => json({ data: endpoints }));

    const result = await service().test(asking({ apiKey: undefined }));

    expect(result).toEqual({
      ok: false,
      models: [],
      error: 'API key required.',
      noRetentionProviders: ['Azure'],
    });
  });

  it.each([
    ['another choice', { dataPolicy: 'no_training' }],
    ['no choice', { dataPolicy: undefined }],
    ['no model', { model: undefined }],
    ['another provider', { provider: 'openai' }],
  ])('are not asked about with %s', async (_case, more) => {
    const asked = openRouter(() => json({ data: endpoints }));

    expect((await service().test(asking(more))).noRetentionProviders).toBeNull();
    expect(asked).not.toContain(LIST);
  });

  it.each([
    ['answers with an error', () => json({ error: 'down' }, 503)],
    ['answers what is not JSON', () => new Response('<html>busy</html>', { status: 200 })],
    ['answers in another shape', () => json({ endpoints: 'none' })],
    [
      'answers far more than the list is',
      // The list itself, as JSON, padded past what is read of an answer.
      () => json({ data: endpoints, pad: 'x'.repeat(16_000_000) }),
    ],
  ])('are not said when the list %s, and the key is still tested', async (_case, list) => {
    openRouter(list);

    expect(await service().test(asking())).toEqual({
      ok: true,
      models: ['openai/gpt-6-luna'],
      error: null,
      noRetentionProviders: null,
    });
  });

  it('come with a key OpenRouter does not know refused, though it lists its models to anybody', async () => {
    const keys: (string | null)[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
      if (String(url) === LIST) return json({ data: endpoints });
      if (String(url) === 'https://openrouter.ai/api/v1/key') {
        keys.push(new Headers(init.headers).get('authorization'));
        return json({ error: { message: 'User not found.', code: 401 } }, 401);
      }
      return json({ data: [{ id: 'openai/gpt-6-luna' }] });
    });

    const result = await service().test(asking({ apiKey: 'sk-or-not-a-key' }));

    expect(result).toEqual({
      ok: false,
      models: [],
      error: 'HTTP 401: User not found.',
      noRetentionProviders: ['Azure'],
    });
    expect(keys).toEqual(['Bearer sk-or-not-a-key']);
  });

  it('are read from one reading of the list for the tests that follow it', async () => {
    const asked = openRouter(() => json({ data: endpoints }));
    const one = service();

    await one.test(asking());
    await one.test(asking({ model: 'some/open-model' }));

    expect(asked.filter((url) => url === LIST)).toHaveLength(1);
  });
});
