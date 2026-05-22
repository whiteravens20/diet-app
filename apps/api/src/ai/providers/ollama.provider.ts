import { Injectable } from '@nestjs/common';
import { Ollama } from 'ollama';
import {
  AiProviderError,
  type AiProviderAdapter,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
} from '../provider.interface.js';

/**
 * Ollama adapter — local, self-hosted models. Needs no API key; the admin
 * points `OLLAMA_BASE_URL` at a reachable Ollama instance. This is the
 * recommended default for fully self-hosted, key-free deployments.
 */
@Injectable()
export class OllamaProvider implements AiProviderAdapter {
  readonly kind = 'ollama' as const;

  async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    const client = new Ollama({ host: opts.baseUrl ?? 'http://localhost:11434' });
    try {
      const res = await client.chat({
        model: opts.model,
        messages,
        stream: false,
        ...(opts.json ? { format: 'json' } : {}),
        options: { temperature: opts.temperature ?? 0.7 },
      });
      return {
        text: res.message.content,
        promptTokens: res.prompt_eval_count ?? 0,
        outputTokens: res.eval_count ?? 0,
      };
    } catch (err) {
      // Connection failures are retryable (instance may be starting / loading).
      throw new AiProviderError('ollama', err instanceof Error ? err.message : String(err), true);
    }
  }
}
