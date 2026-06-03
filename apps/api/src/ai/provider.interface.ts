/**
 * Unified AI provider abstraction. Every provider (OpenAI, Anthropic,
 * OpenRouter, Ollama) implements this single interface so the router can treat
 * them interchangeably and fail over between them.
 */
import type { AiProvider } from '@diet-app/shared';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  model: string;
  apiKey?: string;
  /** Provider base URL — used by Ollama and OpenRouter. */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /** Request a JSON object response when the provider supports it. */
  json?: boolean;
}

export interface CompletionResult {
  text: string;
  promptTokens: number;
  outputTokens: number;
}

/** A single AI backend. Implementations must be stateless and side-effect free. */
export interface AiProviderAdapter {
  readonly kind: AiProvider;
  /** Run a chat completion. Throws on any transport/auth/rate error. */
  chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult>;
}

/** Raised when an adapter cannot serve a request — triggers failover. */
export class AiProviderError extends Error {
  constructor(
    public readonly provider: AiProvider,
    message: string,
    public readonly retryable: boolean,
    public readonly timedOut: boolean = false,
  ) {
    super(message);
  }
}
