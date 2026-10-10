// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import {
  AiProviderError,
  type AiProviderAdapter,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
} from '../provider.interface.js';

/** Anthropic Messages API adapter. */
@Injectable()
export class AnthropicProvider implements AiProviderAdapter {
  readonly kind = 'anthropic' as const;

  async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    if (!opts.apiKey) throw new AiProviderError('anthropic', 'missing API key');
    const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 0 });

    // Anthropic takes `system` separately from the message turns.
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    try {
      const res = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        ...(system ? { system } : {}),
        messages: turns,
      });
      const text = res.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return {
        text,
        promptTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        truncated: res.stop_reason === 'max_tokens',
      };
    } catch (err) {
      throw new AiProviderError(
        'anthropic',
        err instanceof Error ? err.message : String(err),
        err instanceof Anthropic.APIConnectionTimeoutError,
      );
    }
  }
}
