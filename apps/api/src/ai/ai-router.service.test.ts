// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiMode, AiProvider } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AiKeyService, ResolvedProviderConfig } from './ai-key.service.js';
import type { AiQuotaService } from './ai-quota.service.js';
import { AiRouterService } from './ai-router.service.js';
import type { Operation } from './operations.js';
import {
  AiProviderError,
  type AiProviderAdapter,
  type CompletionOptions,
  type CompletionResult,
} from './provider.interface.js';

const OPERATION: Operation = { name: 'test-operation', maxTokens: 250, temperature: 0.1, timeoutMs: 6_000 };
const MESSAGES = [{ role: 'user' as const, content: 'pick one' }];

const answer = (text: string): CompletionResult => ({ text, promptTokens: 7, outputTokens: 3, truncated: false });

/** What one provider does when it is called; each test scripts the ones it uses. */
type Behaviour = (opts: CompletionOptions) => Promise<CompletionResult>;

function setup(input: {
  mode?: AiMode;
  chain?: Partial<ResolvedProviderConfig>[];
  behaviour?: Partial<Record<AiProvider, Behaviour>>;
  quotaExhausted?: boolean;
  env?: Partial<Env>;
}) {
  const calls: { provider: AiProvider; opts: CompletionOptions }[] = [];
  const adapter = (kind: AiProvider): AiProviderAdapter => ({
    kind,
    chat: (_messages, opts) => {
      calls.push({ provider: kind, opts });
      const behave = input.behaviour?.[kind];
      if (!behave) throw new Error(`${kind} was not expected to be called`);
      return behave(opts);
    },
  });

  const chain = (input.chain ?? []).map(
    (entry, priority): ResolvedProviderConfig => ({
      provider: 'openai',
      model: 'some-model',
      priority,
      apiKey: 'key',
      keyUnreadable: false,
      baseUrl: null,
      // Unless a test says otherwise, an entry is the user's own in both senses.
      owner: entry.mode === 'admin' ? 'operator' : 'user',
      mode: 'byok',
      ...entry,
    }),
  );
  /** The usage log: one row per call that was let through, settled with its outcome. */
  const usage: Record<string, unknown>[] = [];
  const env: Partial<Env> = {
    OLLAMA_BASE_URL: 'http://ollama:11434',
    OLLAMA_USER_POLICY: 'allowlist',
    OLLAMA_ALLOWED_HOSTS: '',
    ...input.env,
  };

  const router = new AiRouterService(
    { resolveChain: vi.fn(async () => chain) } as unknown as AiKeyService,
    {
      begin: vi.fn(async (userId: string, call: { mode: string }) => {
        if (input.quotaExhausted && call.mode === 'admin') return { refused: 'quota_exhausted' };
        usage.push({ userId, ...call });
        return { id: String(usage.length - 1) };
      }),
      end: vi.fn(async (id: string, result: Record<string, unknown>) => {
        Object.assign(usage[Number(id)]!, result);
      }),
    } as unknown as AiQuotaService,
    { user: { findUnique: vi.fn(async () => ({ aiMode: input.mode ?? 'byok' })) } } as unknown as PrismaService,
    { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>,
    adapter('openai') as never,
    adapter('anthropic') as never,
    adapter('openrouter') as never,
    adapter('ollama') as never,
  );
  return { router, calls, usage };
}

const fails = (message: string): Behaviour => async () => {
  throw new AiProviderError('openai', message);
};
const timesOut: Behaviour = (opts) =>
  new Promise((_resolve, reject) => {
    setTimeout(() => reject(new AiProviderError('ollama', 'too slow', true)), opts.timeoutMs);
  });

beforeEach(() => {
  vi.useRealTimers();
});

describe('AiRouterService.chat', () => {
  it('answers from the first provider of the chain and logs the call', async () => {
    const { router, calls, usage } = setup({
      chain: [{ provider: 'openai', model: 'gpt-test' }, { provider: 'anthropic' }],
      behaviour: { openai: async () => answer('{"recipeId":"a"}') },
    });

    const result = await router.chat('user-1', MESSAGES, OPERATION, true);

    expect(result.text).toBe('{"recipeId":"a"}');
    expect(result.meta).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      failoverChain: [],
      usedDeterministicFallback: false,
      fallbackReason: null,
    });
    expect(calls.map((c) => c.provider)).toEqual(['openai']);
    expect(usage).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        provider: 'openai',
        model: 'gpt-test',
        mode: 'byok',
        operation: 'test-operation',
        promptTokens: 7,
        outputTokens: 3,
        outcome: 'COMPLETED',
      }),
    ]);
  });

  it('passes the limits of the operation to the provider', async () => {
    const { router, calls } = setup({
      chain: [{ provider: 'openrouter' }],
      behaviour: { openrouter: async () => answer('ok') },
    });

    await router.chat('user-1', MESSAGES, OPERATION, true);

    expect(calls[0]!.opts).toMatchObject({ maxTokens: 250, temperature: 0.1, json: true });
    expect(calls[0]!.opts.timeoutMs).toBeGreaterThan(5_000);
    expect(calls[0]!.opts.timeoutMs).toBeLessThanOrEqual(6_000);
  });

  it('moves on to the next provider when one fails, in the order of the chain', async () => {
    const { router, calls, usage } = setup({
      chain: [{ provider: 'openai' }, { provider: 'anthropic' }, { provider: 'openrouter' }],
      behaviour: {
        openai: fails('401 invalid key'),
        anthropic: fails('529 overloaded'),
        openrouter: async () => answer('third time lucky'),
      },
    });

    const result = await router.chat('user-1', MESSAGES, OPERATION);

    expect(result.text).toBe('third time lucky');
    expect(result.meta.provider).toBe('openrouter');
    expect(result.meta.failoverChain).toEqual(['openai', 'anthropic']);
    expect(calls.map((c) => c.provider)).toEqual(['openai', 'anthropic', 'openrouter']);
    expect(usage.map((row) => [row.provider, row.outcome])).toEqual([
      ['openai', 'FAILED'],
      ['anthropic', 'FAILED'],
      ['openrouter', 'COMPLETED'],
    ]);
  });

  it('hands the decision back to the engine when every provider fails', async () => {
    const { router } = setup({
      chain: [{ provider: 'openai' }, { provider: 'anthropic' }],
      behaviour: { openai: fails('500'), anthropic: fails('500') },
    });

    const result = await router.chat('user-1', MESSAGES, OPERATION);

    expect(result.text).toBeNull();
    expect(result.meta).toMatchObject({
      provider: null,
      usedDeterministicFallback: true,
      fallbackReason: 'all_providers_failed',
      failoverChain: ['openai', 'anthropic'],
    });
  });

  it('calls no provider for a user who turned AI off', async () => {
    const { router, calls, usage } = setup({ mode: 'none', chain: [] });

    const result = await router.chat('user-1', MESSAGES, OPERATION);

    expect(result.meta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'no_provider' });
    expect(calls).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('calls no provider once the monthly allowance of the shared provider is used up', async () => {
    const { router, calls, usage } = setup({
      mode: 'admin',
      chain: [{ provider: 'openai', mode: 'admin' }],
      quotaExhausted: true,
    });

    const result = await router.chat('user-1', MESSAGES, OPERATION);

    expect(result.meta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'quota_exhausted' });
    expect(calls).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  describe('a saved key that can no longer be read', () => {
    it('is passed over, and the next provider answers', async () => {
      const { router, calls, usage } = setup({
        chain: [{ provider: 'openai', apiKey: null, keyUnreadable: true }, { provider: 'anthropic' }],
        behaviour: { anthropic: async () => answer('from the second') },
      });

      const result = await router.chat('user-1', MESSAGES, OPERATION);

      expect(result.text).toBe('from the second');
      expect(result.meta.failoverChain).toEqual(['openai']);
      expect(calls.map((c) => c.provider)).toEqual(['anthropic']);
      // Nothing was asked of the first provider, so nothing is logged for it.
      expect(usage.map((row) => row.provider)).toEqual(['anthropic']);
    });

    it('is the reason given when it leaves no provider to ask', async () => {
      const { router, calls, usage } = setup({
        chain: [{ provider: 'openai', apiKey: null, keyUnreadable: true }],
      });

      const result = await router.chat('user-1', MESSAGES, OPERATION);

      expect(result.text).toBeNull();
      expect(result.meta).toMatchObject({
        usedDeterministicFallback: true,
        fallbackReason: 'key_unreadable',
        failoverChain: ['openai'],
      });
      expect(calls).toHaveLength(0);
      expect(usage).toHaveLength(0);
    });

    it('gives way to the failure of a provider that was asked', async () => {
      const { router } = setup({
        chain: [{ provider: 'openai', apiKey: null, keyUnreadable: true }, { provider: 'anthropic' }],
        behaviour: { anthropic: fails('529 overloaded') },
      });

      const result = await router.chat('user-1', MESSAGES, OPERATION);

      expect(result.meta.fallbackReason).toBe('all_providers_failed');
      expect(result.meta.failoverChain).toEqual(['openai', 'anthropic']);
    });
  });

  it('keeps the answer when the usage log cannot be written', async () => {
    const { router } = setup({
      chain: [{ provider: 'openai' }, { provider: 'anthropic' }],
      behaviour: { openai: async () => answer('still here') },
    });
    // The second provider would be called if a failed write counted as a failed call.
    vi.spyOn(router['quota'], 'end').mockRejectedValue(new Error('database is restarting'));

    const result = await router.chat('user-1', MESSAGES, OPERATION);

    expect(result.text).toBe('still here');
    expect(result.meta.provider).toBe('openai');
  });

  describe('the wait', () => {
    const SHORT: Operation = { ...OPERATION, timeoutMs: 2_400 };

    it('is shared by the providers still to be tried, so a slow one cannot use up the turn of the next', async () => {
      const { router, calls } = setup({
        chain: [{ provider: 'ollama', baseUrl: 'http://ollama:11434' }, { provider: 'openai' }],
        behaviour: { ollama: timesOut, openai: async () => answer('in time') },
      });

      const started = Date.now();
      const result = await router.chat('user-1', MESSAGES, SHORT);

      expect(result.text).toBe('in time');
      expect(result.meta.failoverChain).toEqual(['ollama']);
      // Half of the wait each: the first provider was cut off after its half.
      expect(calls[0]!.opts.timeoutMs).toBe(1_200);
      expect(calls[1]!.opts.timeoutMs).toBeGreaterThan(1_000);
      expect(calls[1]!.opts.timeoutMs).toBeLessThanOrEqual(1_200);
      expect(Date.now() - started).toBeLessThan(2_400);
    });

    it('gives a provider everything that is left when the one before it failed fast', async () => {
      const { router, calls } = setup({
        chain: [{ provider: 'openai' }, { provider: 'anthropic' }],
        behaviour: { openai: fails('401 invalid key'), anthropic: async () => answer('ok') },
      });

      await router.chat('user-1', MESSAGES, SHORT);

      expect(calls[1]!.opts.timeoutMs).toBeGreaterThan(2_000);
    });

    it('is reported as a timeout, and never outlasted, when no provider answers in time', async () => {
      const { router, calls, usage } = setup({
        chain: [
          { provider: 'ollama', baseUrl: 'http://ollama:11434' },
          { provider: 'openai' },
        ],
        behaviour: { ollama: timesOut, openai: timesOut },
      });

      const started = Date.now();
      const result = await router.chat('user-1', MESSAGES, SHORT);

      expect(result.text).toBeNull();
      expect(result.meta.fallbackReason).toBe('provider_timeout');
      expect(calls).toHaveLength(2);
      expect(usage.map((row) => row.outcome)).toEqual(['TIMED_OUT', 'TIMED_OUT']);
      expect(Date.now() - started).toBeLessThan(2_400 + 300);
    });

    it('does not start a provider with no time left to answer', async () => {
      const { router, calls } = setup({
        chain: [{ provider: 'openai' }],
        behaviour: { openai: async () => answer('never asked') },
      });

      const result = await router.chat('user-1', MESSAGES, { ...OPERATION, timeoutMs: 500 });

      expect(result.meta.fallbackReason).toBe('provider_timeout');
      expect(calls).toHaveLength(0);
    });
  });

  describe('an Ollama address', () => {
    it('is checked again before it is dialled, and a refused one is skipped like a failed provider', async () => {
      const { router, calls } = setup({
        chain: [
          { provider: 'ollama', baseUrl: 'http://169.254.169.254' },
          { provider: 'openai' },
        ],
        behaviour: { openai: async () => answer('from the next provider') },
      });

      const result = await router.chat('user-1', MESSAGES, OPERATION);

      expect(result.text).toBe('from the next provider');
      expect(result.meta.failoverChain).toEqual(['ollama']);
      expect(calls.map((c) => c.provider)).toEqual(['openai']);
    });

    it('carries on to the provider that only a public address may be dialled, under the policy that says so', async () => {
      const { router, calls } = setup({
        chain: [{ provider: 'ollama', baseUrl: 'https://ollama.example.org' }],
        behaviour: { ollama: async () => answer('far away') },
        env: { OLLAMA_USER_POLICY: 'public' },
      });

      await router.chat('user-1', MESSAGES, OPERATION);

      expect(calls[0]!.opts).toMatchObject({ baseUrl: 'https://ollama.example.org', publicOnly: true });
    });

    it("skips a user's entry altogether when users may not configure Ollama", async () => {
      const { router, calls } = setup({
        chain: [{ provider: 'ollama', baseUrl: 'http://ollama:11434', mode: 'admin', owner: 'user' }],
        env: { OLLAMA_USER_POLICY: 'off' },
      });

      const result = await router.chat('user-1', MESSAGES, OPERATION);

      expect(result.text).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it("does not hold the operator's own instance to the rules for users", async () => {
      const { router, calls } = setup({
        mode: 'admin',
        chain: [{ provider: 'ollama', mode: 'admin', baseUrl: 'http://10.0.0.5:11434', apiKey: null }],
        behaviour: { ollama: async () => answer('from the rack') },
        env: { OLLAMA_USER_POLICY: 'off' },
      });

      const result = await router.chat('user-1', MESSAGES, OPERATION);

      expect(result.text).toBe('from the rack');
      expect(calls[0]!.opts).toMatchObject({ baseUrl: 'http://10.0.0.5:11434', publicOnly: false });
    });

    it('falls back to the address the operator configured when the row has none', async () => {
      const { router, calls } = setup({
        mode: 'admin',
        chain: [{ provider: 'ollama', mode: 'admin', baseUrl: null, apiKey: null }],
        behaviour: { ollama: async () => answer('local') },
      });

      await router.chat('user-1', MESSAGES, OPERATION);

      expect(calls[0]!.opts.baseUrl).toBe('http://ollama:11434');
    });
  });
});
