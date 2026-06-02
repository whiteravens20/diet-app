import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
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
import { AiQuotaService } from './ai-quota.service.js';
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
   * Try each provider in the chain until one succeeds. `operation` tags usage
   * logs. Empty chain or all-failed → `text: null` (caller falls back to the
   * deterministic engine — AI is never a hard dependency).
   *
   * The chain is built from the user's F10 `aiMode`: `none` short-circuits to
   * the fallback, `byok` walks the user's own configs, `admin` borrows the
   * operator's env-configured provider after a quota guard.
   */
  async chat(
    userId: string,
    messages: ChatMessage[],
    operation: string,
    json = false,
  ): Promise<RoutedResult> {
    const mode = await this.loadAiMode(userId);

    // Quota / availability guards short-circuit BEFORE we hit a provider, so
    // callers always get a clean fallback meta (with `fallbackReason`) instead
    // of a thrown 403. The UI surfaces the reason as a localised toast so the
    // user knows AI didn't run *and why* — never a silent demotion.
    if (mode === 'admin') {
      try {
        await this.quota.assertAllowsAdminCall(userId);
      } catch (err) {
        if (err instanceof ForbiddenException) {
          return fallback('quota_exhausted');
        }
        throw err;
      }
    }

    const chain = await this.keys.resolveChain(userId, mode);
    if (chain.length === 0) return fallback('no_provider');

    const failoverChain: AiProvider[] = [];

    for (const cfg of chain) {
      const adapter = this.adapters[cfg.provider];
      const started = Date.now();
      try {
        const result = await adapter.chat(messages, {
          model: cfg.model,
          apiKey: cfg.apiKey ?? undefined,
          baseUrl:
            cfg.provider === 'ollama'
              ? cfg.baseUrl ?? this.config.get('OLLAMA_BASE_URL', { infer: true })
              : undefined,
          json,
        });
        await this.log(userId, cfg.provider, cfg.model, cfg.mode, operation, result, Date.now() - started, true, false);
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
        this.logger.warn(`AI provider ${cfg.provider} failed: ${describe(err)}`);
        failoverChain.push(cfg.provider);
        await this.log(userId, cfg.provider, cfg.model, cfg.mode, operation, null, Date.now() - started, false, false);
      }
    }

    // Every provider in the chain failed — caller uses the deterministic
    // engine. The UI shows "AI providers all failed, using fallback".
    return fallback('all_providers_failed', failoverChain);
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

  private async log(
    userId: string,
    provider: string,
    model: string,
    mode: 'admin' | 'byok',
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
          mode,
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
