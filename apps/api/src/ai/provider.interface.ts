// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unified AI provider abstraction. Every provider (OpenAI, Anthropic,
 * OpenRouter, Ollama) implements this single interface so the router can treat
 * them interchangeably and fail over between them.
 */
import type { AiDataPolicy, AiProvider } from '@diet-app/shared';
import type { Reasoning } from './operations.js';

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
  /**
   * Connect to the Ollama instance only if its address is a public one. Set
   * for an address a user supplied under a policy that admits any public host.
   */
  publicOnly?: boolean;
  /** Request a JSON object response when the provider supports it. */
  json?: boolean;
  /** The most output tokens the provider may bill for the answer. */
  maxTokens: number;
  temperature: number;
  /** The call is abandoned after this long and reported as timed out. */
  timeoutMs: number;
  /**
   * How much the model is asked to think before it answers, where the
   * provider has a setting for that; unset leaves the model as it is set up.
   * What a model thinks is billed as output and counts against `maxTokens`:
   * a model that thinks about a short answer can spend the whole cap before
   * it writes a word.
   */
  reasoning?: Reasoning;
  /**
   * Which of OpenRouter's endpoints may serve the request, by what they do
   * with its data. OpenRouter alone has the choice; the others ignore it.
   */
  dataPolicy: AiDataPolicy;
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

/**
 * What a provider's refusal says can be done about it, as its status and body
 * tell: each adapter reads its provider's own words.
 */
export type AiFailure =
  /** The key was refused: wrong, revoked or expired. */
  | 'key_refused'
  /** The account behind the key has no credits left, or reached a limit of its spending. */
  | 'no_credits'
  /** The model or its provider is overloaded or down for now: the same request may pass later. */
  | 'busy'
  /** The request was refused as it is: the model's name, a permission or a setting of the account. */
  | 'request_refused'
  /** Anything else: no answer, an error of the provider's own server, an answer that could not be read. */
  | 'other';

/** Raised when an adapter cannot serve a request — triggers failover. */
export class AiProviderError extends Error {
  constructor(
    public readonly provider: AiProvider,
    message: string,
    /** The provider did not answer within the request's `timeoutMs`. */
    public readonly timedOut: boolean = false,
    /**
     * OpenRouter refused the request because no endpoint of the model meets
     * the rule of the data it may be sent with: the request's own, or that
     * of the OpenRouter account the key belongs to.
     */
    public readonly refusedForDataPolicy: boolean = false,
    /** What the refusal says can be done about it. */
    public readonly failure: AiFailure = 'other',
  ) {
    super(message);
  }
}
