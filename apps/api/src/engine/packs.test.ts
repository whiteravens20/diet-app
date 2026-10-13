// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { ACCEPTED_LEFT, DAYS_TO_USE_A_PACK, SPOONFUL, leftBeyondAccepted, leftOf, packPull, packUse, packsFor } from './packs.js';

/** Chicken in packs of 600 g, eggs in cartons of ten (550 g), yogurt in tubs of 500 g. */
const PACKS = new Map([
  ['chicken', 600],
  ['eggs', 550],
  ['yogurt', 500],
]);
const held = (amounts: Record<string, number>) => (ingredientId: string): number => amounts[ingredientId] ?? 0;
const meal = (amounts: Record<string, number>): Map<string, number> => new Map(Object.entries(amounts));

describe('the packs a need takes', () => {
  it('are whole packs, none for no need, and one more when the last is not enough', () => {
    expect(packsFor(0, 600)).toBe(0);
    expect(packsFor(1, 600)).toBe(1);
    expect(packsFor(600, 600)).toBe(1);
    expect(packsFor(700, 600)).toBe(2);
    expect(packsFor(0.3, 0.1)).toBe(3);
  });

  it('are no more for a spoonful over: 8 g of salmon open no fifth pack', () => {
    expect(SPOONFUL).toBe(0.05);
    expect(packsFor(1008, 250)).toBe(4);
    expect(leftOf(1008, 250)).toBe(0);
    // A twentieth of a pack over is a spoonful still; a little more is another pack.
    expect(packsFor(630, 600)).toBe(1);
    expect(packsFor(640, 600)).toBe(2);
    // A need there is takes a pack, however small it is.
    expect(packsFor(10, 600)).toBe(1);
  });

  it('leave what the need does not take of the last one', () => {
    expect(leftOf(550, 600)).toBe(50);
    expect(leftOf(600, 600)).toBe(0);
    expect(leftOf(700, 600)).toBe(500);
    expect(leftOf(0, 600)).toBe(0);
  });

  it('count as used when about seven tenths of the last is', () => {
    expect(ACCEPTED_LEFT).toBe(0.3);
    expect(leftBeyondAccepted(420, 600)).toBe(0);
    expect(leftBeyondAccepted(550, 600)).toBe(0);
    // A third used: two thirds left, of which three tenths are accepted.
    expect(leftBeyondAccepted(200, 600)).toBeCloseTo(2 / 3 - 0.3, 6);
    expect(leftBeyondAccepted(0, 600)).toBe(0);
  });
});

describe('what a meal does to the packs of a plan', () => {
  it('holds a pack it opens and mostly leaves against the meal on the last day of a plan', () => {
    // 150 g of 600: three quarters of the pack would be left, with no day to use them on.
    expect(packPull(meal({ chicken: 150 }), held({}), PACKS)).toBeLessThan(-0.6);
    expect(packPull(meal({ chicken: 150 }), held({}), PACKS, 0)).toBe(packPull(meal({ chicken: 150 }), held({}), PACKS));
    // A meal of a serving and a half of a recipe is one that takes half as much again.
    expect(packPull(meal({ chicken: 100 }), held({}), PACKS, 0, 1.5)).toBe(packPull(meal({ chicken: 150 }), held({}), PACKS));
  });

  it('holds it against no meal with a week of the plan to come, and the less the more days there are', () => {
    const onTheLastDay = packPull(meal({ chicken: 150 }), held({}), PACKS);

    expect(DAYS_TO_USE_A_PACK).toBe(7);
    expect(packPull(meal({ chicken: 150 }), held({}), PACKS, 7)).toBe(0);
    expect(packPull(meal({ chicken: 150 }), held({}), PACKS, 30)).toBe(0);
    expect(packPull(meal({ chicken: 150 }), held({}), PACKS, 3.5)).toBeCloseTo(onTheLastDay / 2, 5);
    expect(packPull(meal({ chicken: 150 }), held({}), PACKS, 6)).toBeGreaterThan(packPull(meal({ chicken: 150 }), held({}), PACKS, 1));
  });

  it('holds nothing against a meal that opens a pack and uses it well', () => {
    expect(packPull(meal({ chicken: 450 }), held({}), PACKS)).toBe(0);
  });

  it('is nothing for an ingredient that is bought loose, or whose pack keeps', () => {
    expect(packPull(meal({ rice: 80, tomato: 240 }), held({ rice: 80, tomato: 100 }), PACKS)).toBe(0);
    expect(packPull(meal({ rice: 80, tomato: 240 }), held({}), PACKS)).toBe(0);
  });

  it('speaks for a meal that takes from a pack that was mostly left, however much of the plan is to come', () => {
    // 200 g of 600 are used; a meal of 200 g more brings the pack to two thirds.
    const pull = packPull(meal({ chicken: 200 }), held({ chicken: 200 }), PACKS);

    expect(pull).toBeGreaterThan(0.4);
    expect(pull).toBeLessThanOrEqual(1);
    expect(packPull(meal({ chicken: 200 }), held({ chicken: 200 }), PACKS, 7)).toBe(pull);
  });

  it('does not speak for a meal that would finish a pack that is used well enough already', () => {
    // 550 g of 600 are used: the 50 g that are left are no reason to plan anything.
    expect(packPull(meal({ chicken: 50 }), held({ chicken: 550 }), PACKS)).toBe(0);
  });

  it('speaks against a meal that would open another pack for what a used one cannot give', () => {
    // 550 g of 600 are used and a meal wants 150 g: a second pack, of which 500 g would be left.
    expect(packPull(meal({ chicken: 150 }), held({ chicken: 550 }), PACKS)).toBeLessThan(-0.7);
    // Nine eggs of ten are used and a meal wants three: a second carton for two eggs.
    expect(packPull(meal({ eggs: 165 }), held({ eggs: 495 }), PACKS)).toBeLessThan(-0.6);
    // With a week to come the second pack has its use.
    expect(packPull(meal({ chicken: 150 }), held({ chicken: 550 }), PACKS, 7)).toBe(0);
  });

  it('holds nothing against a meal that takes a spoonful more than a pack holds', () => {
    // 590 g of 600 are used and a meal wants 30 g: the pack does for it.
    expect(packPull(meal({ chicken: 30 }), held({ chicken: 590 }), PACKS)).toBe(0);
  });

  it('weighs every ingredient of the meal, and stays between minus one and one', () => {
    const both = packPull(meal({ chicken: 200, yogurt: 150 }), held({ chicken: 200, yogurt: 150 }), PACKS);
    const one = packPull(meal({ chicken: 200 }), held({ chicken: 200, yogurt: 150 }), PACKS);

    expect(both).toBeGreaterThan(one);
    expect(packPull(meal({ chicken: 150, eggs: 165, yogurt: 100 }), held({ chicken: 550, eggs: 495, yogurt: 450 }), PACKS)).toBe(-1);
  });
});

describe('what a plan comes to in packs', () => {
  it('is the whole packs it buys against what it uses of them', () => {
    const use = packUse(new Map([['chicken', 880], ['yogurt', 500], ['rice', 330]]), PACKS);

    // Two packs of chicken and one tub of yogurt; the rice is no pack that is counted here.
    expect(use).toMatchObject({ bought: 1700, used: 1380 });
    expect(use.open).toEqual([{ ingredientId: 'chicken', packSize: 600, packs: 2, used: 880, left: 320, wasted: true }]);
  });

  it('names a pack that is left open and used well enough, without calling it wasted', () => {
    const use = packUse(new Map([['chicken', 550]]), PACKS);

    expect(use.open).toEqual([{ ingredientId: 'chicken', packSize: 600, packs: 1, used: 550, left: 50, wasted: false }]);
  });

  it('puts the pack with the most left first', () => {
    const use = packUse(new Map([['chicken', 550], ['yogurt', 100], ['eggs', 275]]), PACKS);

    expect(use.open.map((pack) => pack.ingredientId)).toEqual(['yogurt', 'eggs', 'chicken']);
  });

  it('takes a need that is a spoonful over its packs for the packs, all of them used', () => {
    expect(packUse(new Map([['salmon', 1008]]), new Map([['salmon', 250]]))).toEqual({ bought: 1000, used: 1000, open: [] });
  });

  it('is nothing for a plan that uses nothing that comes in such a pack', () => {
    expect(packUse(new Map([['rice', 330]]), PACKS)).toEqual({ bought: 0, used: 0, open: [] });
    expect(packUse(new Map(), PACKS)).toEqual({ bought: 0, used: 0, open: [] });
  });
});
