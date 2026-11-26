// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { followKitchen, writePlan, writePlans } from './plan-write.js';

const followed = vi.hoisted(() => ({ days: [] as (string | undefined)[] }));
vi.mock('./rests-follow.js', async (original) => ({
  ...(await original<typeof import('./rests-follow.js')>()),
  followRests: vi.fn(async (_tx: unknown, _planId: string, today?: string) => {
    followed.days.push(today);
    return [];
  }),
}));
const chosen = vi.hoisted(() => ({
  said: [] as string[],
  again: [] as string[],
  changed: [] as string[],
}));
vi.mock('./freezer-repick.js', () => ({
  packagesSaid: vi.fn(async (_tx: unknown, _planId: string, today: string) => {
    chosen.said.push(today);
    return new Set<string>();
  }),
  repickFreezer: vi.fn(async (_tx: unknown, planId: string, today: string) => {
    chosen.again.push(today);
    return { kitchen: [planId], changed: chosen.changed };
  }),
}));

const settled = vi.hoisted(() => ({ days: [] as string[] }));
vi.mock('./pots.js', () => ({
  settlePots: vi.fn(async (_tx: unknown, _planId: string, today: string) => {
    settled.days.push(today);
  }),
}));

const recorded = vi.hoisted(() => ({ changes: [] as string[] }));
vi.mock('./day-events.js', () => ({
  markBefore: vi.fn(async () => ({ plans: [] })),
  ownDays: vi.fn(async () => new Set<string>()),
  keepEvents: vi.fn(
    async (
      _tx: unknown,
      _marked: unknown,
      _own: unknown,
      cause: string,
      today: string,
      chosenAgain: ReadonlySet<string>,
    ) => {
      recorded.changes.push(`${cause} ${today} ${[...chosenAgain].join(',')}`.trim());
    },
  ),
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
    chosen.said = [];
    chosen.again = [];
    chosen.changed = [];
    settled.days = [];
    recorded.changes = [];
  });

  it("follows the rests of its packs, chooses its freezer again and settles its pots by the day it is for whoever asked, not the server's", async () => {
    await writePlan(aDatabase(), 'plan-1', 3, '2026-11-23', 'resize', async () => null);
    await writePlans(
      aDatabase(),
      [{ planId: 'plan-2', revision: 0 }],
      '2026-11-21',
      'swap',
      async () => null,
    );

    expect(followed.days).toEqual(['2026-11-23', '2026-11-21']);
    expect(chosen.said).toEqual(['2026-11-23', '2026-11-21']);
    expect(chosen.again).toEqual(['2026-11-23', '2026-11-21']);
    // A meal no longer eaten from a pot cooked already forgets what was cooked for it, by the same day.
    expect(settled.days).toEqual(['2026-11-23', '2026-11-21']);
    // Each day it changes keeps the change in its history, with its cause, by the same day.
    expect(recorded.changes).toEqual(['resize 2026-11-23', 'swap 2026-11-21']);
  });

  it('chooses its freezer again after a purchase by weight moved its rests, and moves on a plan whose choice changed', async () => {
    const update = vi.fn(async () => ({}));
    chosen.changed = ['plan-9'];

    await followKitchen(
      { mealPlan: { update } } as unknown as Parameters<typeof followKitchen>[0],
      'plan-3',
      '2026-11-24',
    );

    expect(followed.days).toEqual(['2026-11-24']);
    // What the freezer gave by today is read before the rests follow, and kept as the choice is made again.
    expect(chosen.said).toEqual(['2026-11-24']);
    expect(chosen.again).toEqual(['2026-11-24']);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'plan-9' },
      data: { revision: { increment: 1 } },
    });
    // Told with the change, so that the plan's notes of the freezer are read again.
    expect(recorded.changes).toEqual(['bought-by-weight 2026-11-24 plan-9']);
  });
});
