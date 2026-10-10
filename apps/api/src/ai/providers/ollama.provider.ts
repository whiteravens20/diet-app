// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ollamaRequest, OllamaRequestError } from '../ollama-http.js';
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
 *
 * The request goes through `ollamaRequest`, not the `ollama` npm client: the
 * address may be a user's, and the deadline has to cancel the request in
 * flight. Without that, a model too slow for the prompt would hold the request
 * until some proxy in front of the API gave up on it.
 */

/**
 * The largest response body that is read. An admin batch of recipes is a few
 * hundred kilobytes; an endpoint that sends more is not answering the prompt,
 * and the body is not buffered beyond this.
 */
const MAX_RESPONSE_BYTES = 2_000_000;

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

@Injectable()
export class OllamaProvider implements AiProviderAdapter {
  readonly kind = 'ollama' as const;

  async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    const host = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    try {
      const res = await ollamaRequest(`${host}/api/chat`, {
        method: 'POST',
        body: {
          model: opts.model,
          messages,
          stream: false,
          ...(opts.json ? { format: 'json' } : {}),
          options: { temperature: opts.temperature, num_predict: opts.maxTokens },
        },
        timeoutMs: opts.timeoutMs,
        maxBytes: MAX_RESPONSE_BYTES,
        publicOnly: opts.publicOnly ?? false,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new AiProviderError(
          'ollama',
          `Ollama HTTP ${res.status} ${res.statusText}${res.text ? `: ${res.text.slice(0, 200)}` : ''}`,
        );
      }
      const body = JSON.parse(res.text) as OllamaChatResponse;
      return {
        text: body.message?.content ?? '',
        promptTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        truncated: body.done_reason === 'length',
      };
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      const timedOut = err instanceof OllamaRequestError && err.failure === 'timeout';
      const message = timedOut
        ? `Ollama did not answer within ${Math.round(opts.timeoutMs / 1000)} s; the model may be too slow for this prompt.`
        : err instanceof Error
          ? err.message
          : String(err);
      throw new AiProviderError('ollama', message, timedOut);
    }
  }
}
