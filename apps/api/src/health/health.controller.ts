// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Liveness + readiness probe used by Docker / Traefik health checks. Without
 * the database the API cannot serve anything, so it answers 503: an
 * orchestrator then sees the instance as unhealthy instead of routing to it.
 */
// Not limited: a probe that was told "too many requests" would report a
// healthy instance as down.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string; db: 'up' | 'down'; time: string }> {
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
