// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiProviderError,
  type AiProviderAdapter,
  type CompletionOptions,
} from '../provider.interface.js';
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
function transport(
  answer: (request: Sent, signal: AbortSignal) => Response | Promise<Response>,
): void {
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
    signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
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
  /** The temperature the request carries: none where the provider refuses one. */
  temperature: number | undefined;
  answer: (text: string) => unknown;
  cutOff: (text: string) => unknown;
}

const cases: Record<string, Case> = {
  openai: {
    adapter: new OpenAiProvider(),
    url: 'https://api.openai.com/v1/chat/completions',
    capField: 'max_completion_tokens',
    temperature: 0.2,
    answer: (text) => openAiAnswer(text),
    cutOff: (text) => openAiAnswer(text, 'length'),
  },
  openrouter: {
    adapter: new OpenRouterProvider(),
    url: 'https://openrouter.ai/api/v1/chat/completions',
    capField: 'max_tokens',
    temperature: 0.2,
    answer: (text) => openAiAnswer(text),
    cutOff: (text) => openAiAnswer(text, 'length'),
  },
  anthropic: {
    adapter: new AnthropicProvider(),
    url: 'https://api.anthropic.com/v1/messages',
    capField: 'max_tokens',
    temperature: undefined,
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
  dataPolicy: 'any',
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe.each(Object.entries(cases))(
  'the %s adapter',
  (_name, { adapter, url, capField, temperature, answer, cutOff }) => {
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
      expect(sent[0]!.body).toMatchObject({ model: 'some-model', [capField]: 321 });
      expect(sent[0]!.body.temperature).toBe(temperature);
      expect(JSON.stringify(sent[0]!.body)).toContain('answer briefly');
      expect(JSON.stringify(sent[0]!.body)).toContain('hello');
    });

    it('says so when the model stopped at the token limit', async () => {
      transport(() => json(200, cutOff('{"recipes":[')));
      await expect(adapter.chat(messages, options())).resolves.toMatchObject({ truncated: true });
    });

    it.each([429, 500, 503])(
      'reports HTTP %i once, without trying again by itself',
      async (status) => {
        transport(() => json(status, { error: { message: 'not now' } }));

        const failed = await failure(adapter.chat(messages, options()));
        expect(failed.timedOut).toBe(false);
        expect(failed.provider).toBe(adapter.kind);
        // Trying the next provider is the router's decision, so the SDK's own retries are off.
        expect(sent).toHaveLength(1);
      },
    );

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
  },
);

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

describe('the endpoints OpenRouter may send a request to', () => {
  const openrouter = cases.openrouter!.adapter;

  it('are those that do not train on the data, those that keep none, or any, as chosen', async () => {
    transport(() => json(200, openAiAnswer('{}')));

    await openrouter.chat(messages, options({ dataPolicy: 'no_training' }));
    await openrouter.chat(messages, options({ dataPolicy: 'no_retention' }));
    await openrouter.chat(messages, options({ dataPolicy: 'any' }));

    expect(sent[0]!.body.provider).toEqual({ data_collection: 'deny' });
    expect(sent[1]!.body.provider).toEqual({ data_collection: 'deny', zdr: true });
    // Any endpoint is the request as it was before there was a choice.
    expect(sent[2]!.body).not.toHaveProperty('provider');
  });

  it('stay the same when a model that cannot answer without thinking is asked again', async () => {
    const refusal = {
      error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' },
    };
    transport((request) =>
      request.body.reasoning ? json(400, refusal) : json(200, openAiAnswer('{}')),
    );

    await openrouter.chat(messages, options({ reasoning: 'none', dataPolicy: 'no_retention' }));

    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.provider).toEqual({ data_collection: 'deny', zdr: true });
  });

  it("fail the request, in OpenRouter's words and asked once, when none of them serves the model", async () => {
    // As OpenRouter answered on 2026-11-16 for a model whose only endpoints train on the data.
    transport(() =>
      json(404, {
        error: {
          code: 404,
          message:
            'No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy',
        },
      }),
    );

    const failed = await failure(
      openrouter.chat(messages, options({ reasoning: 'none', dataPolicy: 'no_training' })),
    );
    expect(failed.message).toContain('No endpoints found matching your data policy');
    expect(failed.timedOut).toBe(false);
    expect(failed.refusedForDataPolicy).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('are named as the cause of the refusal by the step of the routing OpenRouter says failed', async () => {
    // As OpenRouter answered on 2026-11-17 for a model with no endpoint that keeps nothing.
    transport(() =>
      json(404, {
        error: {
          code: 404,
          message:
            'No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy',
          metadata: {
            routing_funnel: [{ step: 'Initial Endpoints', endpoint_count: 1 }],
            failed_routing_step: 'Filter by Data Policy',
          },
        },
      }),
    );

    const failed = await failure(
      openrouter.chat(messages, options({ dataPolicy: 'no_retention' })),
    );

    expect(failed.refusedForDataPolicy).toBe(true);
  });

  it.each([
    // As OpenRouter answered on 2026-11-17 for a model it does not know.
    [400, 'nobody/no-such-model is not a valid model ID'],
    [404, 'No allowed providers are available for the selected model.'],
    [500, 'Internal Server Error'],
  ])('are not the cause of a refusal with %i: "%s"', async (status, message) => {
    transport(() => json(status, { error: { code: status, message } }));

    const failed = await failure(openrouter.chat(messages, options({ dataPolicy: 'no_training' })));

    expect(failed.refusedForDataPolicy).toBe(false);
  });

  it.each(['openai', 'anthropic'])(
    'are no matter of %s, which is sent nothing of them',
    async (name) => {
      const { adapter, answer } = cases[name]!;
      transport(() => json(200, answer('{}')));

      await adapter.chat(messages, options({ dataPolicy: 'no_retention' }));

      expect(sent[0]!.body).not.toHaveProperty('provider');
    },
  );
});

describe('what a refusal says can be done', () => {
  const refusal = (status: number, body: unknown, headers: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  /** A provider, its status, the body and headers it answered with, and what that says can be done. */
  const refusals = [
    // In the shapes of OpenAI's list of error codes, read on 2026-11-19.
    [
      'openai',
      401,
      {
        error: {
          message: 'Incorrect API key provided',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
      {},
      'key_refused',
    ],
    [
      'openai',
      429,
      {
        error: {
          message: 'Credit balance exhausted',
          type: 'insufficient_quota',
          code: 'credit_balance_exhausted',
        },
      },
      {},
      'no_credits',
    ],
    [
      'openai',
      429,
      {
        error: {
          message: 'Project spend limit reached',
          type: 'insufficient_quota',
          code: 'project_spend_limit_exceeded',
        },
      },
      {},
      'no_credits',
    ],
    [
      'openai',
      429,
      {
        error: {
          message: 'You exceeded your current quota',
          type: 'insufficient_quota',
          code: null,
        },
      },
      {},
      'no_credits',
    ],
    [
      'openai',
      429,
      {
        error: {
          message: 'Rate limit reached for requests',
          type: 'requests',
          code: 'rate_limit_exceeded',
        },
      },
      { 'retry-after': '2' },
      'busy',
    ],
    [
      'openai',
      503,
      {
        error: {
          message: 'Model temporarily overloaded',
          type: 'service_unavailable_error',
          code: 'server_is_overloaded',
        },
      },
      {},
      'busy',
    ],
    [
      'openai',
      404,
      {
        error: {
          message: 'The model `nobody` does not exist',
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      },
      {},
      'request_refused',
    ],
    [
      'openai',
      500,
      { error: { message: 'The server had an error', type: 'server_error' } },
      {},
      'other',
    ],
    // In the shapes of OpenRouter's list of error codes, read the same day.
    ['openrouter', 401, { error: { code: 401, message: 'User not found.' } }, {}, 'key_refused'],
    [
      'openrouter',
      402,
      {
        error: {
          code: 402,
          message: 'Insufficient credits. Add more using https://openrouter.ai/credits',
        },
      },
      {},
      'no_credits',
    ],
    [
      'openrouter',
      403,
      {
        error: {
          code: 403,
          message: 'Key limit exceeded. $5.00 of $5.00 used; resets 2026-12-01T00:00:00.000Z.',
          metadata: { limit_source: 'openrouter_key_limit', limit_usd: 5, spend_usd: 5 },
        },
      },
      {},
      'no_credits',
    ],
    [
      'openrouter',
      403,
      {
        error: {
          code: 403,
          message: 'Your input was flagged',
          metadata: { reasons: ['moderation'] },
        },
      },
      {},
      'request_refused',
    ],
    [
      'openrouter',
      429,
      // As OpenRouter answered on the live instance that day, where one provider of the model kept no data.
      {
        error: {
          code: 429,
          message:
            'openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly, or add your own provider key to use your own limits: https://openrouter.ai/workspaces/default/byok',
        },
      },
      {},
      'busy',
    ],
    ['openrouter', 502, { error: { code: 502, message: 'Provider returned error' } }, {}, 'busy'],
    [
      'openrouter',
      503,
      {
        error: {
          code: 503,
          message: 'No available model provider meets your routing requirements',
        },
      },
      {},
      'busy',
    ],
    [
      'openrouter',
      400,
      { error: { code: 400, message: 'nobody/no-such-model is not a valid model ID' } },
      {},
      'request_refused',
    ],
    // In the shapes of Anthropic's list of errors, read the same day.
    [
      'anthropic',
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      {},
      'key_refused',
    ],
    [
      'anthropic',
      402,
      {
        type: 'error',
        error: { type: 'billing_error', message: 'There is an issue with your billing.' },
      },
      {},
      'no_credits',
    ],
    [
      'anthropic',
      429,
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Number of requests has exceeded your rate limit.',
        },
      },
      { 'retry-after': '20' },
      'busy',
    ],
    [
      'anthropic',
      429,
      {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'You have reached your monthly spend cap.' },
      },
      {},
      'no_credits',
    ],
    [
      'anthropic',
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      {},
      'busy',
    ],
    [
      'anthropic',
      404,
      { type: 'error', error: { type: 'not_found_error', message: 'model: nobody' } },
      {},
      'request_refused',
    ],
    [
      'anthropic',
      500,
      { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
      {},
      'other',
    ],
  ] as const;

  it.each(
    refusals.map(
      ([name, status, body, headers, expected]) => [name, status, expected, body, headers] as const,
    ),
  )('of %s answering %i is %s', async (name, status, expected, body, headers) => {
    transport(() => refusal(status, body, headers));

    const failed = await failure(cases[name]!.adapter.chat(messages, options()));

    expect(failed.failure).toBe(expected);
    expect(sent).toHaveLength(1);
  });

  it.each(Object.keys(cases))('of %s, which could not be reached, is none', async (name) => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const failed = await failure(cases[name]!.adapter.chat(messages, options()));

    expect(failed.failure).toBe('other');
    expect(failed.timedOut).toBe(false);
  });
});

describe('asking for an answer without thinking first', () => {
  const openrouter = cases.openrouter!.adapter;
  const refusal = {
    error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' },
  };

  it('says so to OpenRouter in the field it has for that, and not otherwise', async () => {
    transport(() => json(200, openAiAnswer('{}')));

    await openrouter.chat(messages, options({ reasoning: 'none' }));
    await openrouter.chat(messages, options({ reasoning: 'low' }));
    await openrouter.chat(messages, options());

    expect(sent[0]!.body.reasoning).toEqual({ effort: 'none' });
    expect(sent[1]!.body.reasoning).toEqual({ effort: 'low' });
    expect(sent[2]!.body).not.toHaveProperty('reasoning');
  });

  it('asks once when a little thinking is refused: only a request without thinking is asked again', async () => {
    transport(() => json(400, refusal));

    await failure(openrouter.chat(messages, options({ reasoning: 'low' })));

    expect(sent).toHaveLength(1);
  });

  it('asks a model that refuses the setting once more without it, and gives that answer', async () => {
    // A model whose thinking cannot be turned off answers 400 to the request that asks for it.
    transport((request) =>
      request.body.reasoning ? json(400, refusal) : json(200, openAiAnswer('thought it over')),
    );

    await expect(openrouter.chat(messages, options({ reasoning: 'none' }))).resolves.toMatchObject({
      text: 'thought it over',
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).not.toHaveProperty('reasoning');
    expect(sent[1]!.body).toMatchObject({ model: 'some-model', max_tokens: 321 });
  });

  it('reports a request that is refused either way, after asking twice', async () => {
    transport(() => json(400, { error: { message: 'no such model' } }));

    const failed = await failure(openrouter.chat(messages, options({ reasoning: 'none' })));
    expect(failed.message).toContain('no such model');
    expect(failed.timedOut).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it('asks once when the failure is another, or when the request did not carry the setting', async () => {
    transport(() => json(503, { error: { message: 'not now' } }));
    await failure(openrouter.chat(messages, options({ reasoning: 'none' })));
    expect(sent).toHaveLength(1);

    sent.length = 0;
    transport(() => json(400, refusal));
    await failure(openrouter.chat(messages, options()));
    expect(sent).toHaveLength(1);
  });

  it('gives the second request what is left of the wait, not the whole of it again', async () => {
    // The refusal comes late, and the second request is never answered: the call ends when the one wait does.
    transport(async (request, signal) => {
      if (!request.body.reasoning) return hang(request, signal);
      await new Promise((tick) => setTimeout(tick, 200));
      return json(400, refusal);
    });

    const started = performance.now();
    const slow = await failure(
      openrouter.chat(messages, options({ reasoning: 'none', timeoutMs: 500 })),
    );
    expect(slow.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(900);
  });

  it.each(['openai', 'anthropic'])('changes nothing of what %s is sent', async (name) => {
    const { adapter, answer } = cases[name]!;
    transport(() => json(200, answer('{}')));

    await adapter.chat(messages, options({ reasoning: 'none' }));
    await adapter.chat(messages, options());

    expect(sent[0]!.body).toEqual(sent[1]!.body);
  });
});
