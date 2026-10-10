// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

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

/**
 * One request to a model. The three limits are required: a request without
 * them would run on the provider's defaults, which are far looser than
 * anything this application needs.
 */
export interface CompletionOptions {
  model: string;
  apiKey?: string;
  /** Where the Ollama instance is. */
  baseUrl?: string;
  /** Request a JSON object response when the provider supports it. */
  json?: boolean;
  /** The most output tokens the provider may bill for the answer. */
  maxTokens: number;
  temperature: number;
  /** The call is abandoned after this long and reported as timed out. */
  timeoutMs: number;
}

export interface CompletionResult {
  text: string;
  promptTokens: number;
  outputTokens: number;
  /** The answer stopped at `maxTokens`, so it is cut off. */
  truncated: boolean;
}

/** A single AI backend. Implementations must be stateless and side-effect free. */
export interface AiProviderAdapter {
  readonly kind: AiProvider;
  /**
   * Run one chat completion, once: an adapter does not retry, because its
   * caller decides what to try next. Throws `AiProviderError` on any failure.
   */
  chat(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult>;
}

/** Raised when an adapter cannot serve a request — triggers failover. */
export class AiProviderError extends Error {
  constructor(
    public readonly provider: AiProvider,
    message: string,
    /** The provider did not answer within the request's `timeoutMs`. */
    public readonly timedOut: boolean = false,
  ) {
    super(message);
  }
}
