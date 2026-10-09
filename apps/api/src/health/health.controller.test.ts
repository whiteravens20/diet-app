// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HealthController } from './health.controller.js';

function probe(queryRaw: () => Promise<unknown>) {
  const res = { status: vi.fn() } as unknown as Response;
  const controller = new HealthController({ $queryRaw: queryRaw } as unknown as PrismaService);
  return { res, result: controller.check(res) };
}

describe('HealthController', () => {
  it('answers ok while the database answers', async () => {
    const { res, result } = probe(() => Promise.resolve([{ '?column?': 1 }]));
    expect(await result).toMatchObject({ status: 'ok', db: 'up' });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers 503 when the database does not', async () => {
    const { res, result } = probe(() => Promise.reject(new Error('connection refused')));
    expect(await result).toMatchObject({ status: 'degraded', db: 'down' });
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
