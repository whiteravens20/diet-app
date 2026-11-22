// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writePlan, writePlans } from './plan-write.js';

const followed = vi.hoisted(() => ({ days: [] as (string | undefined)[] }));
vi.mock('./rests-follow.js', async (original) => ({
  ...(await original<typeof import('./rests-follow.js')>()),
  followRests: vi.fn(async (_tx: unknown, _planId: string, today?: string) => {
    followed.days.push(today);
    return [];
  }),
}));

/** What a plan that wastes less was made with, as it keeps it. */
const LESS_WASTE = {
  dietType: 'balanced',
  mealCount: 4,
  calorieTargetOverride: null,
  mealPrepFriendly: false,
  respectExclusions: true,
  respectFavorites: true,
  respectInventory: true,
  maxRepeatsPerRecipe: null,
  allowRelaxations: [],
  lessWaste: true,
};

/** A database whose plans are claimed at any revision, of a plan that wastes less. */
function aDatabase(): PrismaClient {
  const tx = {
    $queryRaw: vi.fn(async () => [{ options: LESS_WASTE, jointPlanId: null }]),
    $executeRaw: vi.fn(async () => 0),
    mealPlan: { update: vi.fn(async () => ({})) },
  };
  return {
    $transaction: async (write: (client: typeof tx) => Promise<unknown>) => write(tx),
  } as unknown as PrismaClient;
}

describe('a write of a plan that wastes less', () => {
  beforeEach(() => {
    followed.days = [];
  });

  it("follows the rests of its packs by the day it is for whoever asked, not the server's", async () => {
    await writePlan(aDatabase(), 'plan-1', 3, '2026-11-23', async () => null);
    await writePlans(
      aDatabase(),
      [{ planId: 'plan-2', revision: 0 }],
      '2026-11-21',
      async () => null,
    );

    expect(followed.days).toEqual(['2026-11-23', '2026-11-21']);
  });
});
