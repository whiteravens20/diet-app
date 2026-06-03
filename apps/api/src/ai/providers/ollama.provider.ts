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
 * Uses raw `fetch` rather than the `ollama` npm client so we can pass an
 * `AbortSignal` that actually cancels the in-flight request (the npm client's
 * non-streaming path silently drops `signal`). A hard 60s deadline aborts the
 * call if the model is too slow for the prompt (typical when an undersized
 * GPU runs a 9B+ model at ~1 tok/s). Without the abort, Ollama would block
 * until the upstream Next.js rewrite proxy or the browser kill the socket,
 * which surfaces as a bare 500. With it, the router gets a clean timeout
 * and the user sees `AI_PROVIDER_TIMEOUT` instead of "Internal Server Error".
 */
const OLLAMA_DEADLINE_MS = 60_000;

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

@Injectable()
export class OllamaProvider implements AiProviderAdapter {
  readonly kind = 'ollama' as const;

  async chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    const host = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_DEADLINE_MS);
    try {
      const res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages,
          stream: false,
          ...(opts.json ? { format: 'json' } : {}),
          options: { temperature: opts.temperature ?? 0.7 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new AiProviderError(
          'ollama',
          `Ollama HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
          res.status >= 500,
        );
      }
      const body = (await res.json()) as OllamaChatResponse;
      return {
        text: body.message?.content ?? '',
        promptTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
      };
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      const timedOut = controller.signal.aborted;
      const message = timedOut
        ? `Ollama did not respond within ${OLLAMA_DEADLINE_MS / 1000}s — model may be too slow for this prompt.`
        : err instanceof Error
          ? err.message
          : String(err);
      // Connection failures are retryable (instance may be starting / loading).
      throw new AiProviderError('ollama', message, true, timedOut);
    } finally {
      clearTimeout(timer);
    }
  }
}
