// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Reached } from './water-days-chart';

describe('the tick over a day of water', () => {
  const drawn = (value: number) =>
    render(
      <svg>
        <Reached x={10} y={50} width={20} value={value} target={2000} />
      </svg>,
    ).container.querySelector('[data-reached]');

  it('stands over a day that reached the target, at its middle and above it', () => {
    const tick = drawn(2000);
    expect(tick).not.toBeNull();
    expect(tick!.getAttribute('d')).toBe('M 15 39 l 3.5 3.5 l 6.5 -7');
  });

  it('is not drawn over a day short of the target', () => {
    expect(drawn(1990)).toBeNull();
  });
});
