// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProviderError, type AiProviderAdapter, type CompletionOptions } from '../provider.interface.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import { OpenRouterProvider } from './openrouter.provider.js';

/** One HTTP exchange the SDK made, as the stubbed transport saw it. */
interface Sent {
  url: string;
  body: Record<string, unknown>;
}

const sent: Sent[] = [];

/** Replace the transport of both SDKs with a function of the request. */
function transport(answer: (request: Sent, signal: AbortSignal) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    const request = {
      url: String(url instanceof Request ? url.url : url),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    sent.push(request);
    return answer(request, init.signal as AbortSignal);
  });
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A transport that never answers but notices when the caller gives up. */
const hang = (_request: Sent, signal: AbortSignal): Promise<Response> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

async function failure(call: Promise<unknown>): Promise<AiProviderError> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(AiProviderError);
    return err as AiProviderError;
  }
  throw new Error('the call was expected to fail');
}

const openAiAnswer = (content: string, finish = 'stop') => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
  usage: { prompt_tokens: 12, completion_tokens: 5 },
});
const anthropicAnswer = (text: string, stop = 'end_turn') => ({
  content: [{ type: 'text', text }],
  stop_reason: stop,
  usage: { input_tokens: 12, output_tokens: 5 },
});

interface Case {
  adapter: AiProviderAdapter;
  url: string;
  /** The field of the request that carries the token cap. */
  capField: string;
  answer: (text: string) => unknown;
  cutOff: (text: string) => unknown;
}

const cases: Record<string, Case> = {
  openai: {
    adapter: new OpenAiProvider(),
    url: 'https://api.openai.com/v1/chat/completions',
    capField: 'max_completion_tokens',
    answer: (text) => openAiAnswer(text),
    cutOff: (text) => openAiAnswer(text, 'length'),
  },
  openrouter: {
    adapter: new OpenRouterProvider(),
    url: 'https://openrouter.ai/api/v1/chat/completions',
    capField: 'max_tokens',
    answer: (text) => openAiAnswer(text),
    cutOff: (text) => openAiAnswer(text, 'length'),
  },
  anthropic: {
    adapter: new AnthropicProvider(),
    url: 'https://api.anthropic.com/v1/messages',
    capField: 'max_tokens',
    answer: (text) => anthropicAnswer(text),
    cutOff: (text) => anthropicAnswer(text, 'max_tokens'),
  },
};

const messages = [
  { role: 'system' as const, content: 'answer briefly' },
  { role: 'user' as const, content: 'hello' },
];
const options = (overrides: Partial<CompletionOptions> = {}): CompletionOptions => ({
  model: 'some-model',
  apiKey: 'test-key',
  maxTokens: 321,
  temperature: 0.2,
  timeoutMs: 5_000,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe.each(Object.entries(cases))('the %s adapter', (_name, { adapter, url, capField, answer, cutOff }) => {
  it('sends the model, the limits and the messages, and returns the reply with its token counts', async () => {
    transport(() => json(200, answer('hi there')));

    await expect(adapter.chat(messages, options())).resolves.toEqual({
      text: 'hi there',
      promptTokens: 12,
      outputTokens: 5,
      truncated: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(url);
    expect(sent[0]!.body).toMatchObject({ model: 'some-model', temperature: 0.2, [capField]: 321 });
    expect(JSON.stringify(sent[0]!.body)).toContain('answer briefly');
    expect(JSON.stringify(sent[0]!.body)).toContain('hello');
  });

  it('says so when the model stopped at the token limit', async () => {
    transport(() => json(200, cutOff('{"recipes":[')));
    await expect(adapter.chat(messages, options())).resolves.toMatchObject({ truncated: true });
  });

  it.each([429, 500, 503])('reports HTTP %i once, without trying again by itself', async (status) => {
    transport(() => json(status, { error: { message: 'not now' } }));

    const failed = await failure(adapter.chat(messages, options()));
    expect(failed.timedOut).toBe(false);
    expect(failed.provider).toBe(adapter.kind);
    // Trying the next provider is the router's decision, so the SDK's own retries are off.
    expect(sent).toHaveLength(1);
  });

  it('gives up on a provider that does not answer in time, and says it timed out', async () => {
    transport(hang);

    const started = performance.now();
    const slow = await failure(adapter.chat(messages, options({ timeoutMs: 150 })));
    expect(slow.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(sent).toHaveLength(1);
  });

  it('does not call the provider without a key', async () => {
    transport(() => json(200, answer('unreachable')));
    const failed = await failure(adapter.chat(messages, options({ apiKey: undefined })));
    expect(failed.message).toContain('API key');
    expect(sent).toHaveLength(0);
  });
});

describe('asking for a JSON object', () => {
  it.each(['openai', 'openrouter'])('sets the response format on %s', async (name) => {
    transport(() => json(200, openAiAnswer('{}')));
    await cases[name]!.adapter.chat(messages, options({ json: true }));
    expect(sent[0]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('sends the system prompt apart from the turns on anthropic', async () => {
    transport(() => json(200, anthropicAnswer('{}')));
    await cases.anthropic!.adapter.chat(messages, options({ json: true }));
    expect(sent[0]!.body.system).toBe('answer briefly');
    expect(sent[0]!.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
