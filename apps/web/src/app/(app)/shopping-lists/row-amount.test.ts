// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { rowAmount } from './row-amount';

const formatQty = (qty: number, unit: string) => `${qty} ${unit}`;

describe('a quantity of a shopping row', () => {
  it('has what its pieces weigh beside it, to the gram, for a row in pieces', () => {
    expect(rowAmount(3, { displayUnit: 'piece', gramsPerPiece: 120 }, formatQty)).toBe(
      '3 piece (360 g)',
    );
    expect(rowAmount(1.5, { displayUnit: 'slice', gramsPerPiece: 35 }, formatQty)).toBe(
      '1.5 slice (53 g)',
    );
  });

  it('has no weight beside nothing left to buy', () => {
    expect(rowAmount(0, { displayUnit: 'piece', gramsPerPiece: 55 }, formatQty)).toBe('0 piece');
  });

  it('stays as it is for a row by weight or volume', () => {
    expect(rowAmount(200, { displayUnit: 'g', gramsPerPiece: null }, formatQty)).toBe('200 g');
  });
});
