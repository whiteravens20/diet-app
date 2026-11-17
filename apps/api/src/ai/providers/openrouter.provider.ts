// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import type { AiDataPolicy } from '@diet-app/shared';
import OpenAI from 'openai';
import {
  AiProviderError,
  type AiProviderAdapter,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
} from '../provider.interface.js';
import type { Reasoning } from '../operations.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Which endpoints OpenRouter is to route a request to, by what they do with its data. */
interface EndpointRule {
  /** Only endpoints that do not train on the data; they may still keep it. */
  data_collection: 'deny';
  /** Only endpoints that keep no data. */
  zdr?: true;
}

/**
 * A request as OpenRouter takes it: the OpenAI one, a field of its own that it
 * turns into each vendor's setting for thinking and leaves out for a model
 * that has none, and the rule of the endpoints that may serve it. A request no
 * endpoint of the model serves is refused, unbilled.
 */
type OpenRouterRequest = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
  reasoning?: { effort: Reasoning };
  provider?: EndpointRule;
};

/** The rule each choice asks for; `any` asks for none, and the account's settings alone apply. */
const ENDPOINT_RULES: Record<AiDataPolicy, EndpointRule | undefined> = {
  any: undefined,
  no_training: { data_collection: 'deny' },
  no_retention: { data_collection: 'deny', zdr: true },
};

/** The step of OpenRouter's routing that a request no endpoint of the model may serve fails at. */
const DATA_POLICY_STEP = 'Filter by Data Policy';

/**
 * Whether OpenRouter refused the request because no endpoint of the model
 * meets the rule of the data: the request's, or the one the account's privacy
 * settings make. It answers 404 then, names the step of its routing that
 * failed and says "No endpoints found matching your data policy (…)" (read on
 * 2026-11-16 and 2026-11-17). A model it does not know is a 400.
 */
function refusedForDataPolicy(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status !== 404) return false;
  const body = err.error as
    { message?: unknown; metadata?: { failed_routing_step?: unknown } } | undefined;
  return (
    body?.metadata?.failed_routing_step === DATA_POLICY_STEP ||
    /matching your data policy/i.test(String(body?.message ?? err.message))
  );
}

/** OpenRouter adapter — OpenAI-compatible API, routed across many models. */
@Injectable()
export class OpenRouterProvider implements AiProviderAdapter {
  readonly kind = 'openrouter' as const;

  async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    if (!opts.apiKey) throw new AiProviderError('openrouter', 'missing API key');
    const started = Date.now();
    try {
      try {
        return await this.ask(messages, opts, opts.reasoning, opts.timeoutMs);
      } catch (err) {
        // A model whose thinking cannot be turned off refuses the request that
        // asks for it, at once and unbilled. It is asked again as it is set up,
        // in the time that is left: that is the same request made acceptable,
        // not another try of one that failed.
        if (!(opts.reasoning === 'none' && err instanceof OpenAI.APIError && err.status === 400))
          throw err;
        return await this.ask(
          messages,
          opts,
          undefined,
          Math.max(1, opts.timeoutMs - (Date.now() - started)),
        );
      }
    } catch (err) {
      throw new AiProviderError(
        'openrouter',
        err instanceof Error ? err.message : String(err),
        err instanceof OpenAI.APIConnectionTimeoutError,
        refusedForDataPolicy(err),
      );
    }
  }

  private async ask(
    messages: ChatMessage[],
    opts: CompletionOptions,
    reasoning: Reasoning | undefined,
    timeoutMs: number,
  ): Promise<CompletionResult> {
    const client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: OPENROUTER_BASE_URL,
      timeout: timeoutMs,
      maxRetries: 0,
    });
    const rule = ENDPOINT_RULES[opts.dataPolicy];
    const request: OpenRouterRequest = {
      model: opts.model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
      ...(rule ? { provider: rule } : {}),
    };
    const res = await client.chat.completions.create(request);
    return {
      text: res.choices[0]?.message?.content ?? '',
      promptTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      truncated: res.choices[0]?.finish_reason === 'length',
    };
  }
}
