// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for AiQuotaService (monthly admin quota). Prisma `$queryRaw`
 * and config are mocked. Focus: the status snapshot per aiMode, the admin
 * pre-flight guard, and the "limit 0 disables admin mode" rule.
 */
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AiQuotaService } from './ai-quota.service.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    AI_DEFAULT_PROVIDER: 'openai',
    AI_DEFAULT_MODEL: 'gpt-4o-mini',
    AI_ADMIN_USER_MONTHLY_LIMIT: 40,
    ...overrides,
  };
  return { get: (k: string) => values[k] };
}

/** $queryRaw is used twice: count (returns [{count}]) then oldest ([{resetAt}]). */
function makePrisma(used: number, resetAt: Date | null = null) {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([{ count: BigInt(used) }])
    .mockResolvedValueOnce([{ resetAt }]);
  return { $queryRaw: queryRaw };
}

function makeService(prisma: { $queryRaw: unknown }, config = makeConfig()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles
  return new AiQuotaService(prisma as any, config as any);
}

describe('AiQuotaService.isAdminProviderConfigured', () => {
  it('true when both provider and model are set', () => {
    expect(makeService(makePrisma(0)).isAdminProviderConfigured()).toBe(true);
  });
  it('false when model is missing or empty', () => {
    expect(makeService(makePrisma(0), makeConfig({ AI_DEFAULT_MODEL: undefined })).isAdminProviderConfigured()).toBe(false);
    expect(makeService(makePrisma(0), makeConfig({ AI_DEFAULT_MODEL: '' })).isAdminProviderConfigured()).toBe(false);
  });
  it('false when provider is missing', () => {
    expect(makeService(makePrisma(0), makeConfig({ AI_DEFAULT_PROVIDER: undefined })).isAdminProviderConfigured()).toBe(false);
  });
});

describe('AiQuotaService.status', () => {
  it('returns null remaining/resetAt for non-admin modes', async () => {
    const s = await makeService(makePrisma(3)).status('u1', 'byok');
    expect(s).toMatchObject({ mode: 'byok', limit: 40, used: 3, remaining: null, resetAt: null });
  });

  it('computes remaining for admin mode and clamps at 0', async () => {
    const reset = new Date('2026-07-01T00:00:00Z');
    const s = await makeService(makePrisma(45, reset)).status('u1', 'admin');
    expect(s.remaining).toBe(0); // 40 - 45 clamps to 0
    expect(s.used).toBe(45);
    expect(s.resetAt).toBe(reset.toISOString());
  });

  it('reports remaining under the cap', async () => {
    const s = await makeService(makePrisma(10, new Date())).status('u1', 'admin');
    expect(s.remaining).toBe(30);
  });
});

describe('AiQuotaService.assertAllowsAdminCall', () => {
  it('throws when the monthly limit is 0 (admin disabled)', async () => {
    const svc = makeService(makePrisma(0), makeConfig({ AI_ADMIN_USER_MONTHLY_LIMIT: 0 }));
    await expect(svc.assertAllowsAdminCall('u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws AI_MONTHLY_LIMIT_REACHED when used >= limit', async () => {
    const svc = makeService(makePrisma(40), makeConfig({ AI_ADMIN_USER_MONTHLY_LIMIT: 40 }));
    await expect(svc.assertAllowsAdminCall('u1')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'AI_MONTHLY_LIMIT_REACHED' }),
    });
  });

  it('passes when under the limit', async () => {
    const svc = makeService(makePrisma(5), makeConfig({ AI_ADMIN_USER_MONTHLY_LIMIT: 40 }));
    await expect(svc.assertAllowsAdminCall('u1')).resolves.toBeUndefined();
  });
});
