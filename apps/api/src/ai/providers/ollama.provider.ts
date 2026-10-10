// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
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
 * Uses raw `fetch` rather than the `ollama` npm client so the deadline really
 * cancels the request in flight (the npm client's non-streaming path drops
 * its `signal`). Without that, a model too slow for the prompt would hold the
 * request until some proxy in front of the API gave up on it.
 */

/**
 * The largest response body that is read. An admin batch of recipes is a few
 * hundred kilobytes; an endpoint that sends more is not answering the prompt,
 * and the body is not buffered beyond this.
 */
const MAX_RESPONSE_BYTES = 2_000_000;

/** The response body as text, or an error once it grows past `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new AiProviderError('ollama', `Ollama sent more than ${maxBytes} bytes; the reply was discarded.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages,
          stream: false,
          ...(opts.json ? { format: 'json' } : {}),
          options: { temperature: opts.temperature, num_predict: opts.maxTokens },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new AiProviderError(
          'ollama',
          `Ollama HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        );
      }
      const body = JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES)) as OllamaChatResponse;
      return {
        text: body.message?.content ?? '',
        promptTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        truncated: body.done_reason === 'length',
      };
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      const timedOut = controller.signal.aborted;
      const message = timedOut
        ? `Ollama did not answer within ${Math.round(opts.timeoutMs / 1000)} s; the model may be too slow for this prompt.`
        : err instanceof Error
          ? err.message
          : String(err);
      throw new AiProviderError('ollama', message, timedOut);
    } finally {
      clearTimeout(timer);
    }
  }
}
