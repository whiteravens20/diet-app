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

/** OpenRouter adapter — OpenAI-compatible API, routed across many models. */
@Injectable()
export class OpenRouterProvider implements AiProviderAdapter {
  readonly kind = 'openrouter' as const;

  async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    if (!opts.apiKey) throw new AiProviderError('openrouter', 'missing API key');
    const client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: OPENROUTER_BASE_URL,
      timeout: opts.timeoutMs,
      maxRetries: 0,
    });
    try {
      const res = await client.chat.completions.create({
        model: opts.model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      });
      return {
        text: res.choices[0]?.message?.content ?? '',
        promptTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        truncated: res.choices[0]?.finish_reason === 'length',
      };
    } catch (err) {
      throw new AiProviderError(
        'openrouter',
        err instanceof Error ? err.message : String(err),
        err instanceof OpenAI.APIConnectionTimeoutError,
      );
    }
  }
}
