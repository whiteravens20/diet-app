// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AiFallbackReason, AiMode, AiQuotaStatus } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** A call to a provider, as the usage log records it. */
export interface UsageCall {
  provider: string;
  model: string;
  operation: string;
  /** Who pays: 'admin' is the operator's provider, 'byok' the user's own. */
  mode: 'admin' | 'byok';
}

/** How a call ended, with what the provider reported about it. */
export interface UsageResult {
  outcome: 'COMPLETED' | 'FAILED' | 'TIMED_OUT';
  promptTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

/**
 * Which rows of the usage log count against an allowance: calls to the
 * operator's provider in the last thirty days that the provider completed,
 * plus the ones still in flight. A call the provider never completed was not
 * paid for. A row left PENDING for longer than any call lasts was abandoned
 * (the process stopped in mid-call) and stops holding a place.
 */
const COUNTED = Prisma.sql`
  "mode" = 'admin'
  AND "createdAt" >= NOW() - INTERVAL '30 days'
  AND ("outcome" = 'COMPLETED' OR ("outcome" = 'PENDING' AND "createdAt" >= NOW() - INTERVAL '5 minutes'))`;

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

const ofUser = (userId: string | null): Prisma.Sql =>
  userId === null ? Prisma.empty : Prisma.sql`AND "userId" = ${userId}`;

/**
 * The log of calls to AI providers, and the two monthly allowances on the
 * operator's provider that are counted from it: one per user, one for all
 * users together. Calls on a user's own provider are logged but never limited.
 *
 * **Time source.** All rolling-window arithmetic uses the database's `NOW()`
 * rather than JS `Date.now()`. The api container's wall clock is allowed to
 * drift (and inside Docker often does) — the source of truth is the same
 * Postgres clock that wrote the `createdAt` timestamps, so the cutoff and
 * the row timestamps are always coherent. This avoids a class of bugs where
 * a misconfigured container TZ or NTP-less host would expire users' quotas
 * early or late by hours/days.
 */
@Injectable()
export class AiQuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * True when the admin chain in `AiKeyService.adminChainFromEnv` will actually
   * resolve to a non-empty chain — i.e. when the operator has set BOTH
   * `AI_DEFAULT_PROVIDER` AND `AI_DEFAULT_MODEL`. Checking only the provider
   * here would let the Settings UI offer `admin` mode for an env that the
   * router treats as misconfigured (silent fallback to deterministic).
   */
  isAdminProviderConfigured(): boolean {
    const provider = this.config.get('AI_DEFAULT_PROVIDER', { infer: true });
    const model = this.config.get('AI_DEFAULT_MODEL', { infer: true });
    return provider !== undefined && model !== undefined && model !== '';
  }

  /** Monthly call limit for admin-mode users. 0 means admin mode is disabled. */
  monthlyLimit(): number {
    return this.config.get('AI_ADMIN_USER_MONTHLY_LIMIT', { infer: true });
  }

  /** Monthly call limit of the operator's provider for all users together. */
  instanceLimit(): number {
    return this.config.get('AI_ADMIN_INSTANCE_MONTHLY_LIMIT', { infer: true });
  }

  /**
   * Snapshot the user's quota — what the app-shell chip and Settings card
   * render. `limit` is the operator's env-configured monthly cap and is
   * returned regardless of the caller's mode (the Settings UI gates the
   * `admin` option on it). `remaining` and `resetAt` are only meaningful for
   * `admin` callers, so they're null for `none`/`byok`. `used` is still the
   * rolling-30d count of admin calls so a user who flips back byok→admin
   * sees their prior usage.
   */
  async status(userId: string, mode: AiMode): Promise<AiQuotaStatus> {
    const used = await this.countUsed(this.prisma, userId);
    const instanceLimitReached = (await this.countUsed(this.prisma, null)) >= this.instanceLimit();
    const adminProviderConfigured = this.isAdminProviderConfigured();
    const limit = this.monthlyLimit();
    if (mode !== 'admin') {
      return {
        mode,
        limit,
        used,
        remaining: null,
        resetAt: null,
        instanceLimitReached,
        adminProviderConfigured,
      };
    }
    return {
      mode,
      limit,
      used,
      remaining: instanceLimitReached ? 0 : Math.max(0, limit - used),
      // While the instance is full, a place comes free when its oldest call ages out.
      resetAt: await this.oldestCountedAt(instanceLimitReached ? null : userId),
      instanceLimitReached,
      adminProviderConfigured,
    };
  }

  /**
   * Record that a provider is about to be asked, and return the row to settle
   * when it answers. For the operator's provider this is also where the
   * allowances are enforced, the user's and the instance's: the counts and
   * the new row are written under one lock, so calls started at the same
   * moment cannot all take the last place.
   */
  async begin(userId: string, call: UsageCall): Promise<{ id: string } | { refused: AiFallbackReason }> {
    const data = { userId, ...call, outcome: 'PENDING' as const };
    if (call.mode !== 'admin') {
      return this.prisma.aiUsageLog.create({ data, select: { id: true } });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ai-allowance'))`;
      const limit = this.monthlyLimit();
      if (limit === 0 || (await this.countUsed(tx, userId)) >= limit) {
        return { refused: 'quota_exhausted' as const };
      }
      if ((await this.countUsed(tx, null)) >= this.instanceLimit()) {
        return { refused: 'instance_quota_exhausted' as const };
      }
      return tx.aiUsageLog.create({ data, select: { id: true } });
    });
  }

  /** Record how a call ended. Only a completed one keeps its place in the allowance. */
  async end(id: string, result: UsageResult): Promise<void> {
    await this.prisma.aiUsageLog.update({ where: { id }, data: result });
  }

  /** Counted calls of one user, or of the whole instance when `userId` is null. */
  private async countUsed(db: Db, userId: string | null): Promise<number> {
    const rows = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "AiUsageLog"
      WHERE ${COUNTED} ${ofUser(userId)}
    `);
    return Number(rows[0]?.count ?? 0n);
  }

  private async oldestCountedAt(userId: string | null): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ resetAt: Date | null }>>(Prisma.sql`
      SELECT MIN("createdAt") + INTERVAL '30 days' AS "resetAt"
      FROM "AiUsageLog"
      WHERE ${COUNTED} ${ofUser(userId)}
    `);
    const resetAt = rows[0]?.resetAt;
    return resetAt ? resetAt.toISOString() : null;
  }
}
