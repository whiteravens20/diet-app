// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { AnthropicProvider } from '../../ai/providers/anthropic.provider.js';
import { OllamaProvider } from '../../ai/providers/ollama.provider.js';
import { OpenAiProvider } from '../../ai/providers/openai.provider.js';
import { OpenRouterProvider } from '../../ai/providers/openrouter.provider.js';
import type { AiProviderAdapter } from '../../ai/provider.interface.js';
import type { Operation } from '../../ai/operations.js';
import { PROVIDER_TUNING } from './ai-helpers.js';

/**
 * The model the operator set for the administrator's runs
 * (`AI_DEFAULT_PROVIDER`, `AI_DEFAULT_MODEL`), asked directly: such a run is
 * the instance's own work, with its own key, and counts against no user.
 */
@Injectable()
export class AdminModelService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly openai: OpenAiProvider,
    private readonly anthropic: AnthropicProvider,
    private readonly openrouter: OpenRouterProvider,
    private readonly ollama: OllamaProvider,
  ) {}

  get provider(): string | null {
    return this.config.get('AI_DEFAULT_PROVIDER', { infer: true }) ?? null;
  }

  get model(): string | null {
    return this.config.get('AI_DEFAULT_MODEL', { infer: true }) ?? null;
  }

  /** Whether the operator named a provider and a model. */
  get configured(): boolean {
    return Boolean(this.provider && this.model);
  }

  /** How freely this provider's models write, how much goes into one call and how long to wait between calls. */
  get tuning(): (typeof PROVIDER_TUNING)[keyof typeof PROVIDER_TUNING] {
    return PROVIDER_TUNING[this.adapter().kind];
  }

  /** One request for a JSON answer, within the limits of the operation. */
  async ask(prompt: string, limits: Operation): Promise<{ text: string; truncated: boolean }> {
    const adapter = this.adapter();
    const result = await adapter.chat([{ role: 'user', content: prompt }], {
      model: this.model!,
      apiKey: this.keyOf(adapter),
      baseUrl:
        adapter.kind === 'ollama' ? this.config.get('OLLAMA_BASE_URL', { infer: true }) : undefined,
      json: true,
      maxTokens: limits.maxTokens,
      temperature: limits.temperature,
      timeoutMs: limits.timeoutMs,
    });
    return { text: result.text, truncated: Boolean(result.truncated) };
  }

  private adapter(): AiProviderAdapter {
    switch (this.provider) {
      case 'openai':
        return this.openai;
      case 'anthropic':
        return this.anthropic;
      case 'openrouter':
        return this.openrouter;
      case 'ollama':
        return this.ollama;
      default:
        throw new Error(`unknown AI_DEFAULT_PROVIDER: ${String(this.provider)}`);
    }
  }

  private keyOf(adapter: AiProviderAdapter): string | undefined {
    switch (adapter.kind) {
      case 'openai':
        return this.config.get('OPENAI_API_KEY', { infer: true });
      case 'anthropic':
        return this.config.get('ANTHROPIC_API_KEY', { infer: true });
      case 'openrouter':
        return this.config.get('OPENROUTER_API_KEY', { infer: true });
      case 'ollama':
        return undefined;
    }
  }
}
