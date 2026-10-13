// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get, Res } from '@nestjs/common';
import { Health } from '@diet-app/shared';
import { Answers } from '../common/answers.decorator.js';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Liveness + readiness probe used by Docker / Traefik health checks. Without
 * the database the API cannot serve anything, so it answers 503: an
 * orchestrator then sees the instance as unhealthy instead of routing to it.
 *
 * Limited like every other route: each request asks the database, and a
 * route without a limit is one anybody can use to keep it busy. A probe is
 * counted against its own address, which is not that of the visitors: the
 * container's own check comes from inside the container.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether the API is up and reaches its database: 200, or 503 with the database down. */
  @Get()
  @Answers(Health)
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<Health> {
    let db: 'up' | 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }
    if (db === 'down') res.status(503);
    return { status: db === 'up' ? 'ok' : 'degraded', db, time: new Date().toISOString() };
  }
}
