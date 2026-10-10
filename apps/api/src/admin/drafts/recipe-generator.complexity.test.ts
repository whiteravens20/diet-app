// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPLEXITY_MIX, planCalls, targetsForMix } from './recipe-generator.complexity.js';

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
