import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AiMode, AiQuotaStatus } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * F10 weekly quota for `aiMode='admin'` users.
 *
 * Counts AiUsageLog rows with `userId=<user>`, `mode='admin'` and
 * `createdAt >= NOW() - INTERVAL '7 days'`. `byok` and `none` callers don't
 * consume this — they get `null` for limit/remaining in the status snapshot.
 *
 * **Time source.** All rolling-window arithmetic uses the database's `NOW()`
 * rather than JS `Date.now()`. The api container's wall clock is allowed to
 * drift (and inside Docker often does) — the source of truth is the same
 * Postgres clock that wrote the `createdAt` timestamps, so the cutoff and
 * the row timestamps are always coherent. This avoids a class of bugs where
 * a misconfigured container TZ or NTP-less host would expire users' quotas
 * early or late by hours/days.
 *
 * The status snapshot powers the app-shell chip and the Settings AI card;
 * `assertAllowsAdminCall()` is the pre-flight guard the router runs before
 * dispatching an admin-mode call so the user sees `AI_WEEKLY_LIMIT_REACHED`
 * instead of an opaque provider failure.
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

  /** Weekly call limit for admin-mode users. 0 means admin mode is disabled. */
  weeklyLimit(): number {
    return this.config.get('AI_ADMIN_USER_WEEKLY_LIMIT', { infer: true });
  }

  /**
   * Snapshot the user's quota — what the app-shell chip and Settings card
   * render. For `none`/`byok` the limit/remaining/resetAt are null because
   * no quota applies; `used` is still the rolling-7d count of admin calls
   * so a user who flips back from byok→admin sees their prior usage.
   */
  async status(userId: string, mode: AiMode): Promise<AiQuotaStatus> {
    const used = await this.countUsedLastWeek(userId);
    const adminProviderConfigured = this.isAdminProviderConfigured();
    if (mode !== 'admin') {
      return {
        mode,
        limit: null,
        used,
        remaining: null,
        resetAt: null,
        adminProviderConfigured,
      };
    }
    const limit = this.weeklyLimit();
    return {
      mode,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetAt: await this.oldestCountedAt(userId),
      adminProviderConfigured,
    };
  }

  /**
   * Pre-flight guard for admin-mode calls. Throws `AI_WEEKLY_LIMIT_REACHED`
   * (403) when the user has spent the rolling-week budget. Never called for
   * byok/none — the router decides which mode to dispatch first.
   */
  async assertAllowsAdminCall(userId: string): Promise<void> {
    const limit = this.weeklyLimit();
    if (limit === 0) {
      throw new ForbiddenException({
        error: 'AI_WEEKLY_LIMIT_REACHED',
        message: 'Admin AI mode is disabled on this instance.',
      });
    }
    const used = await this.countUsedLastWeek(userId);
    if (used >= limit) {
      throw new ForbiddenException({
        error: 'AI_WEEKLY_LIMIT_REACHED',
        message: 'Weekly AI request limit reached.',
      });
    }
  }

  private async countUsedLastWeek(userId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "AiUsageLog"
      WHERE "userId" = ${userId}
        AND "mode" = 'admin'
        AND "createdAt" >= NOW() - INTERVAL '7 days'
    `);
    return Number(rows[0]?.count ?? 0n);
  }

  private async oldestCountedAt(userId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ resetAt: Date | null }>>(Prisma.sql`
      SELECT MIN("createdAt") + INTERVAL '7 days' AS "resetAt"
      FROM "AiUsageLog"
      WHERE "userId" = ${userId}
        AND "mode" = 'admin'
        AND "createdAt" >= NOW() - INTERVAL '7 days'
    `);
    const resetAt = rows[0]?.resetAt;
    return resetAt ? resetAt.toISOString() : null;
  }
}
