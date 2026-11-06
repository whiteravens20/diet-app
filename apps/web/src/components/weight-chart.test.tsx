// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { weightAxis } from './weight-chart';

describe('the weight axis', () => {
  it('reaches a target far from the weights logged, with room under it', () => {
    // Weights of 91 to 92.4 kg and a target of 89: the line stands above the axis's floor.
    expect(weightAxis([92.4, 92, 91.7, 91.5, 91.2, 91, 89])).toEqual([88, 93]);
  });

  it('keeps a steady weight off its edges, and ends at whole units', () => {
    expect(weightAxis([80, 80, 80])).toEqual([79, 81]);
    expect(weightAxis([79.85, 80.6])).toEqual([79, 82]);
  });
});
