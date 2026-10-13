// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import {
  AiProviderError,
  type AiProviderAdapter,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
} from '../provider.interface.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * A request as OpenRouter takes it: the OpenAI one, and a field of its own
 * that it turns into each vendor's setting for thinking and leaves out for a
 * model that has none.
 */
type OpenRouterRequest = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { reasoning?: { effort: 'none' } };

/** OpenRouter adapter — OpenAI-compatible API, routed across many models. */
@Injectable()
export class OpenRouterProvider implements AiProviderAdapter {
  readonly kind = 'openrouter' as const;

  async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    if (!opts.apiKey) throw new AiProviderError('openrouter', 'missing API key');
    const started = Date.now();
    try {
      try {
        return await this.ask(messages, opts, opts.direct === true, opts.timeoutMs);
      } catch (err) {
        // A model whose thinking cannot be turned off refuses the request that
        // asks for it, at once and unbilled. It is asked again as it is set up,
        // in the time that is left: that is the same request made acceptable,
        // not another try of one that failed.
        if (!(opts.direct && err instanceof OpenAI.APIError && err.status === 400)) throw err;
        return await this.ask(messages, opts, false, Math.max(1, opts.timeoutMs - (Date.now() - started)));
      }
    } catch (err) {
      throw new AiProviderError(
        'openrouter',
        err instanceof Error ? err.message : String(err),
        err instanceof OpenAI.APIConnectionTimeoutError,
      );
    }
  }

  private async ask(messages: ChatMessage[], opts: CompletionOptions, direct: boolean, timeoutMs: number): Promise<CompletionResult> {
    const client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: OPENROUTER_BASE_URL,
      timeout: timeoutMs,
      maxRetries: 0,
    });
    const request: OpenRouterRequest = {
      model: opts.model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      ...(direct ? { reasoning: { effort: 'none' } } : {}),
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
