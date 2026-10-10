// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiMode, AiProviderConfig, AiProviderConfigInput } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { decrypt, encrypt } from '../common/crypto.js';
import { assertAllowedOllamaUrl, isOperatorOllama, OllamaUrlError, parseAllowedHosts } from './ollama-url.js';

/** A resolved provider config with the decrypted key, for internal use only. */
export interface ResolvedProviderConfig {
  provider: AiProviderConfig['provider'];
  model: string;
  priority: number;
  apiKey: string | null;
  /** Per-config base URL — Ollama only. Null for other providers. */
  baseUrl: string | null;
  /** Who set the entry up. An address in a user's entry is checked before it is dialled. */
  owner: 'operator' | 'user';
  /**
   * Who pays for a call through this entry, recorded in `AiUsageLog.mode`:
   * 'admin' is the operator, whose monthly allowances apply; 'byok' is the
   * user. A user's own Ollama entry that points at the operator's instance is
   * the operator's to pay for.
   */
  mode: 'admin' | 'byok';
}

/**
 * Manages per-user (and admin-default) AI provider configuration. API keys are
 * AES-256-GCM encrypted on write and never returned to clients — the public DTO
 * exposes only `hasKey`.
 */
@Injectable()
export class AiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get encKey(): string {
    return this.config.get('AI_KEY_ENCRYPTION_SECRET', { infer: true });
  }

  async list(userId: string): Promise<AiProviderConfig[]> {
    const rows = await this.prisma.aiProviderConfig.findMany({
      where: { OR: [{ userId }, { isAdminDefault: true }] },
      orderBy: { priority: 'asc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async upsert(userId: string, input: AiProviderConfigInput): Promise<AiProviderConfig> {
    const existing = await this.prisma.aiProviderConfig.findFirst({
      where: { userId, provider: input.provider },
    });
    const encryptedKey = input.apiKey ? encrypt(input.apiKey, this.encKey) : undefined;

    const baseUrl = input.provider === 'ollama' ? input.baseUrl ?? null : null;
    // SSRF guard: a persisted Ollama baseUrl is later dialled by the router, so
    // reject a disallowed host at write time rather than on every chat call.
    if (input.provider === 'ollama' && baseUrl) {
      try {
        assertAllowedOllamaUrl(baseUrl, {
          policy: this.config.get('OLLAMA_USER_POLICY', { infer: true }),
          defaultBaseUrl: this.config.get('OLLAMA_BASE_URL', { infer: true }),
          allowedHosts: parseAllowedHosts(
            this.config.get('OLLAMA_ALLOWED_HOSTS', { infer: true }),
          ),
        });
      } catch (err) {
        if (err instanceof OllamaUrlError) {
          throw new BadRequestException({ error: err.code, message: err.message });
        }
        throw err;
      }
    }
    const row = existing
      ? await this.prisma.aiProviderConfig.update({
          where: { id: existing.id },
          data: {
            model: input.model,
            priority: input.priority,
            enabled: input.enabled,
            baseUrl,
            ...(encryptedKey !== undefined ? { encryptedKey } : {}),
          },
        })
      : await this.prisma.aiProviderConfig.create({
          data: {
            userId,
            provider: input.provider,
            model: input.model,
            priority: input.priority,
            enabled: input.enabled,
            encryptedKey,
            baseUrl,
          },
        });
    return this.toDto(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = await this.prisma.aiProviderConfig.findUnique({ where: { id } });
    if (!row || row.userId !== userId) {
      throw new NotFoundException({ error: 'AI_CONFIG_NOT_FOUND', message: 'Provider config not found.' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.aiProviderConfig.delete({ where: { id } });
      // If this was the user's last BYOK config, flip them back to admin mode
      // — leaving aiMode='byok' with no providers would route every AI call to
      // an empty chain → deterministic fallback on every operation, no signal
      // to the user that their setup is broken. Admin mode is the safe default.
      const remaining = await tx.aiProviderConfig.count({ where: { userId } });
      if (remaining === 0) {
        await tx.user.updateMany({
          where: { id: userId, aiMode: 'byok' },
          data: { aiMode: 'admin' },
        });
      }
    });
  }

  /**
   * The failover chain for a user.
   *
   * The chain depends on the user's `aiMode`:
   * - `none`  → empty chain; caller falls back to the deterministic engine.
   * - `byok`  → only the user's own enabled `AiProviderConfig` rows, ordered
   *             by priority. No admin failover.
   * - `admin` → the operator's env-configured default (`AI_DEFAULT_PROVIDER` +
   *             `AI_DEFAULT_MODEL`) as a single-entry chain. The admin keys
   *             come from env (OPENAI_API_KEY / ANTHROPIC_API_KEY / …) or
   *             from an Ollama base URL — no DB row required.
   *
   * The modes never share a failover chain: a mode states the user's intent
   * (privacy / cost / quota), so they are disjoint by design.
   */
  async resolveChain(userId: string, mode: AiMode): Promise<ResolvedProviderConfig[]> {
    if (mode === 'none') return [];
    if (mode === 'byok') {
      const rows = await this.prisma.aiProviderConfig.findMany({
        where: { enabled: true, userId },
        orderBy: { priority: 'asc' },
      });
      const operatorOllama = this.config.get('OLLAMA_BASE_URL', { infer: true });
      return rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        priority: r.priority,
        apiKey: r.encryptedKey ? decrypt(r.encryptedKey, this.encKey) : null,
        baseUrl: r.baseUrl,
        owner: 'user' as const,
        mode:
          r.provider === 'ollama' && isOperatorOllama(r.baseUrl ?? operatorOllama, operatorOllama)
            ? ('admin' as const)
            : ('byok' as const),
      }));
    }
    return this.adminChainFromEnv();
  }

  private adminChainFromEnv(): ResolvedProviderConfig[] {
    const provider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true });
    const model = this.config.get('AI_DEFAULT_MODEL', { infer: true });
    if (!provider || !model) return [];
    const apiKey =
      provider === 'openai'
        ? this.config.get('OPENAI_API_KEY', { infer: true })
        : provider === 'anthropic'
          ? this.config.get('ANTHROPIC_API_KEY', { infer: true })
          : provider === 'openrouter'
            ? this.config.get('OPENROUTER_API_KEY', { infer: true })
            : null;
    const baseUrl =
      provider === 'ollama' ? this.config.get('OLLAMA_BASE_URL', { infer: true }) ?? null : null;
    return [
      {
        provider,
        model,
        priority: 0,
        apiKey: apiKey ?? null,
        baseUrl,
        owner: 'operator',
        mode: 'admin',
      },
    ];
  }

  private toDto(row: {
    id: string;
    provider: AiProviderConfig['provider'];
    model: string;
    priority: number;
    enabled: boolean;
    isAdminDefault: boolean;
    encryptedKey: string | null;
    baseUrl: string | null;
  }): AiProviderConfig {
    return {
      id: row.id,
      provider: row.provider,
      model: row.model,
      priority: row.priority,
      enabled: row.enabled,
      isAdminDefault: row.isAdminDefault,
      hasKey: row.encryptedKey !== null,
      baseUrl: row.baseUrl,
    };
  }
}
