// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { batchMixDrift, DEFAULT_COMPLEXITY_MIX, planCalls, targetsForMix } from './recipe-generator.complexity.js';

const size = (call: Record<string, number>): number => call.simple! + call.medium! + call.complex!;

describe('planCalls', () => {
  it.each([
    [1, 3],
    [7, 3],
    [25, 3],
    [25, 5],
    [4, 10],
  ])('splits %i recipes into calls of at most %i that add up to the mix', (count, perCall) => {
    const calls = planCalls(count, perCall, DEFAULT_COMPLEXITY_MIX);

    expect(calls).toHaveLength(Math.ceil(count / perCall));
    for (const call of calls) {
      expect(size(call)).toBeGreaterThan(0);
      expect(size(call)).toBeLessThanOrEqual(perCall);
    }
    const total = { simple: 0, medium: 0, complex: 0 };
    for (const call of calls) {
      total.simple += call.simple;
      total.medium += call.medium;
      total.complex += call.complex;
    }
    expect(total).toEqual(targetsForMix(count, DEFAULT_COMPLEXITY_MIX));
  });

  it('spreads a band over the calls instead of leaving it to the last one', () => {
    const calls = planCalls(12, 3, { simple: 1, medium: 1, complex: 1 });
    for (const call of calls) expect(call).toEqual({ simple: 1, medium: 1, complex: 1 });
  });

  it('asks for one band only when the mix names one', () => {
    const calls = planCalls(5, 2, { simple: 1, medium: 0, complex: 0 });
    expect(calls).toEqual([
      { simple: 2, medium: 0, complex: 0 },
      { simple: 2, medium: 0, complex: 0 },
      { simple: 1, medium: 0, complex: 0 },
    ]);
  });
});

describe('whether a run came out with another mix than it was asked for', () => {
  const thirds = { simple: 1, medium: 1, complex: 1 };
  const drift = (realised: Record<string, number>, total: number, target = thirds) =>
    batchMixDrift({ realised: { simple: 0, medium: 0, complex: 0, ...realised }, target, total });

  it('is not said of a run that wrote what it was asked for, however few recipes that was', () => {
    for (const total of [1, 2, 3, 4, 7, 25]) {
      expect(drift(targetsForMix(total, DEFAULT_COMPLEXITY_MIX), total, DEFAULT_COMPLEXITY_MIX), `a run of ${total}`).toEqual({ drifted: false, deltas: { simple: 0, medium: 0, complex: 0 } });
    }
  });

  it('is said of a run whose recipes are of other bands than were asked for, by more than a quarter of the run', () => {
    // Twelve were asked for in thirds, and nine of them came out simple.
    expect(drift({ simple: 9, medium: 2, complex: 1 }, 12)).toEqual({ drifted: true, deltas: { simple: 42, medium: -17, complex: -25 } });
    // One recipe was asked for, and another kind was written.
    expect(drift({ complex: 1 }, 1, { simple: 1, medium: 0, complex: 0 }).drifted).toBe(true);
  });

  it('is not said of a run that is off by a quarter of itself or less', () => {
    expect(drift({ simple: 5, medium: 4, complex: 3 }, 12).drifted).toBe(false);
    expect(drift({ simple: 7, medium: 3, complex: 2 }, 12)).toMatchObject({ drifted: false, deltas: { simple: 25 } });
  });

  it('holds a run to the tolerance it is given', () => {
    expect(batchMixDrift({ realised: { simple: 5, medium: 4, complex: 3 }, target: thirds, total: 12, tolerancePp: 5 }).drifted).toBe(true);
  });

  it('is not said of a run that wrote nothing', () => {
    expect(drift({}, 0)).toEqual({ drifted: false, deltas: { simple: 0, medium: 0, complex: 0 } });
  });
});
