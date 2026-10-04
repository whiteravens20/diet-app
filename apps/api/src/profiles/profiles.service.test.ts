// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for ProfilesService. Prisma is mocked; the calorie engine is the
 * real (pure, deterministic) function so `calories()` is exercised end-to-end.
 * Focus: ownership/limit guards, the create/update mapping, and DTO defaults
 * when a profile has no preferences row.
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MAX_PROFILES_PER_ACCOUNT } from '@diet-app/shared';
import { describe, expect, it, vi } from 'vitest';
import { ProfilesService } from './profiles.service.js';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'user-1',
    name: 'Cutting',
    age: 30,
    sex: 'male' as const,
    heightCm: 180,
    weightKg: 80,
    activityLevel: 'moderate' as const,
    dietType: 'balanced' as const,
    weeklyLossTarget: '0.5',
    manualCalorieTarget: null,
    mealCount: 3,
    weightReminderCadence: 'weekly',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    preferences: null,
    ...overrides,
  };
}

function makePrisma(row = makeRow(), count = 0) {
  return {
    profile: {
      findMany: vi.fn().mockResolvedValue([row]),
      findUnique: vi.fn().mockResolvedValue(row),
      count: vi.fn().mockResolvedValue(count),
      create: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue(row),
      delete: vi.fn().mockResolvedValue(row),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return new ProfilesService(prisma as any);
}

describe('ProfilesService.create', () => {
  it('rejects when the per-account limit is reached', async () => {
    const prisma = makePrisma(makeRow(), MAX_PROFILES_PER_ACCOUNT);
    await expect(
      makeService(prisma).create('user-1', { name: 'X', preferences: {} } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.profile.create).not.toHaveBeenCalled();
  });

  it('creates a profile with a nested preferences create', async () => {
    const prisma = makePrisma(makeRow(), 0);
    await makeService(prisma).create('user-1', {
      name: 'Cutting', age: 30, sex: 'male', heightCm: 180, weightKg: 80,
      activityLevel: 'moderate', dietType: 'balanced', mealCount: 3,
      weightReminderCadence: 'weekly', preferences: { allergens: [] },
    } as never);
    expect(prisma.profile.create.mock.calls[0][0].data.preferences).toEqual({ create: { allergens: [] } });
  });
});

describe('ProfilesService ownership (load guard)', () => {
  it('throws PROFILE_NOT_FOUND when absent', async () => {
    const prisma = makePrisma();
    prisma.profile.findUnique = vi.fn().mockResolvedValue(null);
    await expect(makeService(prisma).get('user-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('throws FORBIDDEN for another user’s profile', async () => {
    const prisma = makePrisma(makeRow({ userId: 'other' }));
    await expect(makeService(prisma).get('user-1', 'p1')).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('blocks update + delete on a foreign profile', async () => {
    const prisma = makePrisma(makeRow({ userId: 'other' }));
    await expect(makeService(prisma).update('user-1', 'p1', { name: 'x', preferences: {} } as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeService(prisma).remove('user-1', 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.profile.delete).not.toHaveBeenCalled();
  });
});

describe('ProfilesService.toDto', () => {
  it('fills preference defaults when the row has no preferences', async () => {
    const dto = await makeService(makePrisma(makeRow({ preferences: null }))).get('user-1', 'p1');
    expect(dto.preferences).toMatchObject({
      favoriteIngredientIds: [],
      maxConsecutiveDaysSameMeal: 2,
      maxTimesPerWeekSameMeal: 3,
      inventoryBiasResetEvery: 5,
    });
    expect(dto.weightReminderCadence).toBe('weekly');
  });
});

describe('ProfilesService.calories', () => {
  it('delegates to the deterministic engine and returns a calorie target', async () => {
    const calc = await makeService(makePrisma()).calories('user-1', 'p1');
    // Engine math is unit-tested elsewhere; here we assert the wiring produces
    // a sane positive target for a typical profile.
    expect(calc.dailyTarget).toBeGreaterThan(1000);
    expect(calc.dailyTarget).toBeLessThan(5000);
  });
});
