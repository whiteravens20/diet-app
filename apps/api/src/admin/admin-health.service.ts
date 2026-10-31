// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminHealth } from '@diet-app/shared';
import { AiQuotaService } from '../ai/ai-quota.service.js';
import { PACKAGE_VERSION } from '../app-config/package-version.js';
import { readWorkerPass } from '../common/worker-pass.js';
import type { Env } from '../config/env.js';
import { RequestTimes } from '../health/request-times.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** How the instance stands, for its administrator. */
@Injectable()
export class AdminHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly quota: AiQuotaService,
    private readonly times: RequestTimes,
  ) {}

  async read(now = new Date()): Promise<AdminHealth> {
    return {
      checkedAt: now.toISOString(),
      database: await this.database(),
      worker: await readWorkerPass(this.prisma, now).catch(() => ({
        state: 'none' as const,
        lastPassAt: null,
        failedJobs: 0,
      })),
      api: {
        version: PACKAGE_VERSION,
        startedAt: new Date(now.getTime() - process.uptime() * 1000).toISOString(),
        memoryBytes: process.memoryUsage.rss(),
      },
      requests: this.times.summary(),
      ai: {
        configured: this.quota.isAdminProviderConfigured(),
        used: await this.quota.instanceUsed().catch(() => 0),
        limit: this.quota.instanceLimit(),
      },
      mail: { configured: Boolean(this.config.get('SMTP_HOST', { infer: true })) },
    };
  }

  /** Whether the database answers, how fast, and how much it holds. */
  private async database(): Promise<AdminHealth['database']> {
    const started = performance.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const pingMs = Math.round(performance.now() - started);
      const [size] = await this.prisma.$queryRaw<{ bytes: bigint }[]>`
        SELECT pg_database_size(current_database()) AS bytes`;
      return { up: true, pingMs, bytes: size ? Number(size.bytes) : null };
    } catch {
      return { up: false, pingMs: null, bytes: null };
    }
  }
}
