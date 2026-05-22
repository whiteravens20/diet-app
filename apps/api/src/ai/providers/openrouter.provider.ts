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
    if (!opts.apiKey) throw new AiProviderError('openrouter', 'missing API key', false);
    const client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? OPENROUTER_BASE_URL,
    });
    try {
      const res = await client.chat.completions.create({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2048,
      });
      return {
        text: res.choices[0]?.message?.content ?? '',
        promptTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new AiProviderError(
        'openrouter',
        err instanceof Error ? err.message : String(err),
        status === 429 || (status !== undefined && status >= 500),
      );
    }
  }
}
