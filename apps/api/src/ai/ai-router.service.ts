import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiGenerationMeta, AiProvider } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiKeyService } from './ai-key.service.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { OllamaProvider } from './providers/ollama.provider.js';
import { OpenAiProvider } from './providers/openai.provider.js';
import { OpenRouterProvider } from './providers/openrouter.provider.js';
import type { AiProviderAdapter, ChatMessage } from './provider.interface.js';

/** Result of a routed AI call. `text` is null when every provider failed. */
export interface RoutedResult {
  text: string | null;
  meta: AiGenerationMeta;
}

/**
 * Routes an AI request through the user's failover chain. On total failure it
 * returns `text: null` so callers fall back to the deterministic engine — AI is
 * never a hard dependency (product principle #8).
 */
@Injectable()
export class AiRouterService {
  private readonly logger = new Logger(AiRouterService.name);
  private readonly adapters: Record<AiProvider, AiProviderAdapter>;

  constructor(
    private readonly keys: AiKeyService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    openai: OpenAiProvider,
    anthropic: AnthropicProvider,
    openrouter: OpenRouterProvider,
    ollama: OllamaProvider,
  ) {
    this.adapters = { openai, anthropic, openrouter, ollama };
  }

  /**
   * Try each provider in the chain until one succeeds. `operation` tags usage
   * logs. Empty chain or all-failed → `text: null`.
   */
  async chat(
    userId: string,
    messages: ChatMessage[],
    operation: string,
    json = false,
  ): Promise<RoutedResult> {
    const chain = await this.keys.resolveChain(userId);
    const failoverChain: AiProvider[] = [];

    for (const cfg of chain) {
      const adapter = this.adapters[cfg.provider];
      const started = Date.now();
      try {
        const result = await adapter.chat(messages, {
          model: cfg.model,
          apiKey: cfg.apiKey ?? undefined,
          baseUrl: cfg.provider === 'ollama'
            ? this.config.get('OLLAMA_BASE_URL', { infer: true })
            : undefined,
          json,
        });
        await this.log(userId, cfg.provider, cfg.model, operation, result, Date.now() - started, true, false);
        return {
          text: result.text,
          meta: {
            provider: cfg.provider,
            model: cfg.model,
            failoverChain,
            usedDeterministicFallback: false,
            rejectedIngredients: [],
            remappedIngredients: [],
          },
        };
      } catch (err) {
        this.logger.warn(`AI provider ${cfg.provider} failed: ${describe(err)}`);
        failoverChain.push(cfg.provider);
        await this.log(userId, cfg.provider, cfg.model, operation, null, Date.now() - started, false, false);
      }
    }

    // Whole chain exhausted (or empty) — caller uses the deterministic engine.
    return {
      text: null,
      meta: {
        provider: null,
        model: null,
        failoverChain,
        usedDeterministicFallback: true,
        rejectedIngredients: [],
        remappedIngredients: [],
      },
    };
  }

  private async log(
    userId: string,
    provider: string,
    model: string,
    operation: string,
    result: { promptTokens: number; outputTokens: number } | null,
    latencyMs: number,
    success: boolean,
    fellBack: boolean,
  ): Promise<void> {
    await this.prisma.aiUsageLog
      .create({
        data: {
          userId,
          provider,
          model,
          operation,
          promptTokens: result?.promptTokens ?? 0,
          outputTokens: result?.outputTokens ?? 0,
          latencyMs,
          success,
          fellBackToDeterministic: fellBack,
        },
      })
      .catch((e) => this.logger.error('failed to write AI usage log', e));
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
