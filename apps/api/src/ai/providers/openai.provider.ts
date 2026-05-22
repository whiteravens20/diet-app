import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import {
  AiProviderError,
  type AiProviderAdapter,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
} from '../provider.interface.js';

/** OpenAI Chat Completions adapter. */
@Injectable()
export class OpenAiProvider implements AiProviderAdapter {
  readonly kind = 'openai' as const;

  async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    if (!opts.apiKey) throw new AiProviderError('openai', 'missing API key', false);
    const client = new OpenAI({ apiKey: opts.apiKey });
    try {
      const res = await client.chat.completions.create({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2048,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      });
      return {
        text: res.choices[0]?.message?.content ?? '',
        promptTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      throw new AiProviderError('openai', describe(err), isRetryable(err));
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 429 / 5xx are transient; auth/validation errors are not. */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || (status !== undefined && status >= 500);
}
