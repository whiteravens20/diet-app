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
    if (!opts.apiKey) throw new AiProviderError('anthropic', 'missing API key', false);
    const client = new Anthropic({ apiKey: opts.apiKey });

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
        max_tokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.7,
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
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new AiProviderError(
        'anthropic',
        err instanceof Error ? err.message : String(err),
        status === 429 || (status !== undefined && status >= 500),
      );
    }
  }
}
