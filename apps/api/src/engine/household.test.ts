// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { shareAtHome, shareOut, sharePurchase } from './household.js';

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

describe('sharing an amount out', () => {
  it('shares by weight in whole numbers that add up, the largest remainders taking the rest', () => {
    expect(shareOut(100, [700, 500])).toEqual([58, 42]);
    expect(shareOut(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(sum(shareOut(1301, [3, 7, 11]))).toBe(1301);
  });

  it('gives no part more than its cap, and what a full part cannot take to the others', () => {
    expect(shareOut(600, [1, 1], [100, 1000])).toEqual([100, 500]);
    // Beyond what the caps hold together, each takes its cap.
    expect(shareOut(5000, [1, 1], [700, 500])).toEqual([700, 500]);
  });

  it('shares by the room left where no part with room has a weight', () => {
    expect(shareOut(400, [300, 0], [300, 500])).toEqual([300, 100]);
    expect(shareOut(9, [0, 0])).toEqual([5, 4]);
  });

  it('keeps what is not whole as it is, adding up all the same', () => {
    const parts = shareOut(1.5, [1, 2]);
    expect(sum(parts)).toBeCloseTo(1.5, 9);
    expect(parts[1]).toBeGreaterThan(parts[0]!);
  });

  it('gives nothing of nothing', () => {
    expect(shareOut(0, [3, 4])).toEqual([0, 0]);
  });
});

describe('what a household has at home, shared among its plans', () => {
  const chicken = [
    { need: 700, atHome: 300 },
    { need: 500, atHome: 0 },
  ];

  it('stays where the pantries had it', () => {
    expect(shareAtHome(300, chicken)).toEqual([300, 0]);
    expect(shareAtHome(150, chicken)).toEqual([150, 0]);
  });

  it('goes to the plans that still have room once the pantry that had it is full, and never beyond a need', () => {
    expect(shareAtHome(900, chicken)).toEqual([700, 200]);
    expect(shareAtHome(5000, chicken)).toEqual([700, 500]);
  });

  it('is shared by need where no pantry had any', () => {
    expect(
      shareAtHome(600, [
        { need: 700, atHome: 0 },
        { need: 500, atHome: 0 },
      ]),
    ).toEqual([350, 250]);
  });
});

describe('what a household holds for a row once it shopped, shared among its plans', () => {
  const chicken = [
    { need: 700, atHome: 300 },
    { need: 500, atHome: 0 },
  ];

  it('gives each plan what it has at home and what it lacks, and the rest of the pack by need', () => {
    // 300 g at home and a pack of 1000 g: the needs take 900 g, the 100 g over go 7 to 5.
    const held = sharePurchase(1300, chicken);
    expect(held).toEqual([758, 542]);
    expect(sum(held)).toBe(1300);
    expect(held[0]).toBeGreaterThanOrEqual(700);
    expect(held[1]).toBeGreaterThanOrEqual(500);
  });

  it('shares what falls short of the needs by what each plan lacks', () => {
    // 600 g bought for 400 and 500 g lacking.
    expect(sharePurchase(900, chicken)).toEqual([567, 333]);
  });

  it('shares less than is at home as it is at home', () => {
    expect(sharePurchase(200, chicken)).toEqual([200, 0]);
    expect(
      sharePurchase(0, [
        { need: 2, atHome: 0 },
        { need: 3, atHome: 0 },
      ]),
    ).toEqual([0, 0]);
  });

  it('counts whole pieces in whole pieces', () => {
    const eggs = [
      { need: 4, atHome: 1 },
      { need: 3, atHome: 1 },
    ];
    // Ten eggs at home and in the box: the needs take seven, the three over go 4 to 3.
    const held = sharePurchase(10, eggs);
    expect(held.every(Number.isInteger)).toBe(true);
    expect(sum(held)).toBe(10);
    expect(held).toEqual([6, 4]);
  });
});
