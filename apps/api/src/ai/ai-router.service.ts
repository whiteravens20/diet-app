// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AiFallbackReason,
  AiGenerationMeta,
  AiMode,
  AiProvider,
} from '@diet-app/shared';
import { AiMode as AiModeSchema } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiKeyService } from './ai-key.service.js';
import { AiQuotaService, type UsageResult } from './ai-quota.service.js';
import { assertAllowedOllamaUrl, parseAllowedHosts } from './ollama-url.js';
import type { Operation } from './operations.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { OllamaProvider } from './providers/ollama.provider.js';
import { OpenAiProvider } from './providers/openai.provider.js';
import { OpenRouterProvider } from './providers/openrouter.provider.js';
import {
  AiProviderError,
  type AiProviderAdapter,
  type ChatMessage,
} from './provider.interface.js';

/** A provider is not tried with less time than this left; the request is reported as timed out instead. */
const SHORTEST_ATTEMPT_MS = 1_000;

/** Result of a routed AI call. `text` is null when every provider failed. */
export interface RoutedResult {
  text: string | null;
  meta: AiGenerationMeta;
}

/**
 * Routes an AI request through the user's failover chain. On total failure it
 * returns `text: null` so callers fall back to the deterministic engine — AI is
 * never a hard dependency.
 */
@Injectable()
export class AiRouterService {
  private readonly logger = new Logger(AiRouterService.name);
  private readonly adapters: Record<AiProvider, AiProviderAdapter>;

  constructor(
    private readonly keys: AiKeyService,
    private readonly quota: AiQuotaService,
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
   * Try each provider in the chain until one succeeds. `operation` sets the
   * limits of the request and tags usage logs. Empty chain or all-failed →
   * `text: null` (caller falls back to the deterministic engine — AI is never
   * a hard dependency).
   *
   * The chain is built from the user's `aiMode`: `none` short-circuits to
   * the fallback, `byok` walks the user's own configs, `admin` borrows the
   * operator's env-configured provider, as far as the monthly allowance goes.
   * A refused call is not an error: the caller gets a fallback with the
   * reason, which the UI shows, so the user knows AI did not run and why.
   *
   * The operation's wait covers the whole chain. Each provider still to be
   * tried gets an equal share of the time that is left, so a slow first
   * provider cannot use up the turn of the next, and the request as a whole
   * never outlasts the wait.
   */
  async chat(
    userId: string,
    messages: ChatMessage[],
    operation: Operation,
    json = false,
  ): Promise<RoutedResult> {
    const mode = await this.loadAiMode(userId);
    const chain = await this.keys.resolveChain(userId, mode);
    if (chain.length === 0) return fallback('no_provider');

    const failoverChain: AiProvider[] = [];
    let anyTimedOut = false;
    let refused: AiFallbackReason | null = null;
    let asked = 0;
    const deadline = Date.now() + operation.timeoutMs;

    for (const [index, cfg] of chain.entries()) {
      const adapter = this.adapters[cfg.provider];
      const started = Date.now();
      const timeoutMs = Math.floor((deadline - started) / (chain.length - index));
      if (timeoutMs < SHORTEST_ATTEMPT_MS) {
        anyTimedOut = true;
        break;
      }
      const call = await this.quota.begin(userId, {
        provider: cfg.provider,
        model: cfg.model,
        operation: operation.name,
        mode: cfg.mode,
      });
      if ('refused' in call) {
        refused = call.refused;
        continue;
      }
      asked += 1;
      try {
        let baseUrl: string | undefined;
        let publicOnly = false;
        if (cfg.provider === 'ollama') {
          const defaultBaseUrl = this.config.get('OLLAMA_BASE_URL', { infer: true });
          baseUrl = cfg.baseUrl ?? defaultBaseUrl;
          // A user's address was checked when it was saved; it is checked again
          // here, because the policy may have changed since. A refused host is
          // skipped like any other provider failure (the chain continues /
          // falls back).
          if (cfg.owner === 'user') {
            publicOnly = assertAllowedOllamaUrl(baseUrl, {
              policy: this.config.get('OLLAMA_USER_POLICY', { infer: true }),
              defaultBaseUrl,
              allowedHosts: parseAllowedHosts(
                this.config.get('OLLAMA_ALLOWED_HOSTS', { infer: true }),
              ),
            }).publicOnly;
          }
        }
        const result = await adapter.chat(messages, {
          model: cfg.model,
          apiKey: cfg.apiKey ?? undefined,
          baseUrl,
          publicOnly,
          json,
          maxTokens: operation.maxTokens,
          temperature: operation.temperature,
          timeoutMs,
        });
        if (result.truncated) {
          this.logger.warn(
            `AI provider ${cfg.provider} cut its answer to ${operation.name} at ${operation.maxTokens} tokens`,
          );
        }
        await this.settle(call.id, {
          outcome: 'COMPLETED',
          promptTokens: result.promptTokens,
          outputTokens: result.outputTokens,
          latencyMs: Date.now() - started,
        });
        return {
          text: result.text,
          meta: {
            provider: cfg.provider,
            model: cfg.model,
            failoverChain,
            usedDeterministicFallback: false,
            fallbackReason: null,
            rejectedIngredients: [],
            remappedIngredients: [],
          },
        };
      } catch (err) {
        const timedOut = err instanceof AiProviderError && err.timedOut;
        if (timedOut) anyTimedOut = true;
        this.logger.warn(`AI provider ${cfg.provider} failed: ${describe(err)}`);
        failoverChain.push(cfg.provider);
        await this.settle(call.id, {
          outcome: timedOut ? 'TIMED_OUT' : 'FAILED',
          latencyMs: Date.now() - started,
        });
      }
    }

    // No provider was asked because the allowance did not permit it.
    if (asked === 0 && refused) return fallback(refused);
    // Every provider in the chain failed — caller uses the deterministic
    // engine. Surface timeout distinctly so the UI can hint at "your model is
    // too slow" instead of a generic "didn't respond".
    return fallback(anyTimedOut ? 'provider_timeout' : 'all_providers_failed', failoverChain);
  }

  /** Settle a usage row. A failure to write it must not cost the user the answer. */
  private async settle(id: string, result: UsageResult): Promise<void> {
    await this.quota.end(id, result).catch((e) => this.logger.error('failed to write AI usage log', e));
  }

  private async loadAiMode(userId: string): Promise<AiMode> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { aiMode: true },
    });
    if (!row) return 'none';
    const parsed = AiModeSchema.safeParse(row.aiMode);
    return parsed.success ? parsed.data : 'none';
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the soft-fallback result the router returns when AI is unavailable. */
function fallback(
  reason: AiFallbackReason,
  failoverChain: AiProvider[] = [],
): RoutedResult {
  return {
    text: null,
    meta: {
      provider: null,
      model: null,
      failoverChain,
      usedDeterministicFallback: true,
      fallbackReason: reason,
      rejectedIngredients: [],
      remappedIngredients: [],
    },
  };
}
