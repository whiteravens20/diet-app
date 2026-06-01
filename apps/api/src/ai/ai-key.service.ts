import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiMode, AiProviderConfig, AiProviderConfigInput } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { decrypt, encrypt } from '../common/crypto.js';

/** A resolved provider config with the decrypted key, for internal use only. */
export interface ResolvedProviderConfig {
  provider: AiProviderConfig['provider'];
  model: string;
  priority: number;
  apiKey: string | null;
  /** Routing mode that produced this entry — surfaced in AiUsageLog.mode. */
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

    const row = existing
      ? await this.prisma.aiProviderConfig.update({
          where: { id: existing.id },
          data: {
            model: input.model,
            priority: input.priority,
            enabled: input.enabled,
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
          },
        });
    return this.toDto(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = await this.prisma.aiProviderConfig.findUnique({ where: { id } });
    if (!row || row.userId !== userId) {
      throw new NotFoundException({ error: 'AI_CONFIG_NOT_FOUND', message: 'Provider config not found.' });
    }
    await this.prisma.aiProviderConfig.delete({ where: { id } });
  }

  /**
   * F10-aware failover chain for a user.
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
   * Earlier behaviour mixed BYOK and admin into one failover chain; F10 makes
   * the user's intent explicit (privacy / cost / quota), so the modes are
   * disjoint by design.
   */
  async resolveChain(userId: string, mode: AiMode): Promise<ResolvedProviderConfig[]> {
    if (mode === 'none') return [];
    if (mode === 'byok') {
      const rows = await this.prisma.aiProviderConfig.findMany({
        where: { enabled: true, userId },
        orderBy: { priority: 'asc' },
      });
      return rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        priority: r.priority,
        apiKey: r.encryptedKey ? decrypt(r.encryptedKey, this.encKey) : null,
        mode: 'byok' as const,
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
    return [
      {
        provider,
        model,
        priority: 0,
        apiKey: apiKey ?? null,
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
  }): AiProviderConfig {
    return {
      id: row.id,
      provider: row.provider,
      model: row.model,
      priority: row.priority,
      enabled: row.enabled,
      isAdminDefault: row.isAdminDefault,
      hasKey: row.encryptedKey !== null,
    };
  }
}
