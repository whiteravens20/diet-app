// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it, vi } from 'vitest';
import { heldAtPots, keepHeld } from './pots.js';

describe('what a sizing says of the meals eaten from a pot cooked already', () => {
  const rows = [
    { id: 'lunch', quantityScale: 1, mostScale: 1.2 },
    { id: 'dinner', quantityScale: 1, mostScale: 1.5 },
    { id: 'breakfast', quantityScale: 1 },
  ];

  it('holds one it left at its pot that the same sizing without the pots gives more, and not one under its pot', () => {
    const scales = new Map([
      ['lunch', 1.2],
      ['dinner', 1.3],
      ['breakfast', 1.3],
    ]);
    const free = new Map([
      ['lunch', 1.4],
      ['dinner', 1.6],
      ['breakfast', 1.1],
    ]);

    expect(heldAtPots(rows, scales, () => free)).toEqual(
      new Map([
        ['dinner', false],
        ['lunch', true],
      ]),
    );
  });

  it('says nothing new of one at its pot that the sizing without the pots gives no more, as of a day left as it was', () => {
    expect(heldAtPots(rows, new Map([['lunch', 1.2]]), () => new Map([['lunch', 1.2]]))).toEqual(
      new Map([['dinner', false]]),
    );
  });

  it('does not ask the sizing without the pots where none is at its pot', () => {
    const free = vi.fn(() => new Map<string, number>());

    expect(heldAtPots(rows, new Map([['lunch', 1.1]]), free)).toEqual(
      new Map([
        ['lunch', false],
        ['dinner', false],
      ]),
    );
    expect(free).not.toHaveBeenCalled();
  });
});

describe('what is written of the meals a sizing holds at their pots', () => {
  it('marks those held and clears those no longer held', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));

    await keepHeld(
      { plannedMeal: { updateMany } } as never,
      new Map([
        ['lunch', true],
        ['dinner', false],
      ]),
    );

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['lunch'] }, potHeld: false },
      data: { potHeld: true },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['dinner'] }, potHeld: true },
      data: { potHeld: false },
    });
  });

  it('is nothing where the sizing said nothing', async () => {
    const updateMany = vi.fn();

    await keepHeld({ plannedMeal: { updateMany } } as never, new Map());

    expect(updateMany).not.toHaveBeenCalled();
  });
});
