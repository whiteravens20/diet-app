// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_LEFT,
  DAYS_TO_USE_A_PACK,
  SPOONFUL,
  keepDaysOf,
  freezerWalk,
  freshPurchases,
  frozenLeft,
  packLastDays,
  packPull,
  packStep,
  packUse,
  packagesTaken,
  isDueSoon,
  packsFor,
  thawAll,
  thawHeld,
  packsLeft,
  packsLeftBeyondAccepted,
  packsLeftOver,
  type Opened,
  type Pack,
} from './packs.js';

/** Chicken in packs of 600 g that keep two days, eggs in cartons of ten (550 g) for four weeks, yogurt in tubs of 500 g for a week, olives in a jar of 160 g for a month. */
const PACKS = new Map<string, Pack>([
  ['chicken', { size: 600, keepDays: 2 }],
  ['eggs', { size: 550, keepDays: 28 }],
  ['yogurt', { size: 500, keepDays: 7 }],
  ['olives', { size: 160, keepDays: 30 }],
]);
const open =
  (packs: Record<string, Opened>) =>
  (ingredientId: string): Opened | undefined =>
    packs[ingredientId];
const meal = (amounts: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(amounts));
/** What a menu takes of each ingredient on each of `days` days, given as `[day, amount]`. */
const daily = (days: number, needs: Record<string, [number, number][]>) =>
  new Map(
    Object.entries(needs).map(([id, list]) => {
      const row = Array.from({ length: days }, () => 0);
      for (const [day, amount] of list) row[day]! += amount;
      return [id, row];
    }),
  );

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
    // A twentieth of a pack over is a spoonful still; a little more is another pack.
    expect(packsFor(630, 600)).toBe(1);
    expect(packsFor(640, 600)).toBe(2);
    // A need there is takes a pack, however small it is.
    expect(packsFor(10, 600)).toBe(1);
  });
});

describe('the days an opened pack keeps', () => {
  it('are the ingredient’s own where it has them', () => {
    expect(keepDaysOf({ keepDays: 4, category: 'dairy' })).toBe(4);
    expect(keepDaysOf({ keepDays: 30, category: 'meat' })).toBe(30);
  });

  it('are two for meat and fish and three for anything else where it has none yet', () => {
    expect(keepDaysOf({ keepDays: null, category: 'meat' })).toBe(2);
    expect(keepDaysOf({ category: 'fish' })).toBe(2);
    expect(keepDaysOf({ keepDays: null, category: 'dairy' })).toBe(3);
    expect(keepDaysOf({ keepDays: 0, category: 'vegetables' })).toBe(3);
    expect(keepDaysOf({})).toBe(3);
  });
});

describe('a day’s need of an ingredient', () => {
  const chicken = PACKS.get('chicken')!;

  it('opens a pack, eats what it needs and keeps the rest open for the days the pack keeps', () => {
    expect(packStep(undefined, 200, chicken, 3)).toEqual({
      opened: { left: 400, until: 4 },
      bought: 600,
      used: 200,
      thrown: undefined,
    });
  });

  it('takes from the open pack on its last day, and opens nothing', () => {
    expect(packStep({ left: 400, until: 4 }, 300, chicken, 4)).toEqual({
      opened: { left: 100, until: 4 },
      bought: 0,
      used: 300,
      thrown: undefined,
    });
  });

  it('throws away what is in a pack past its last day, and opens another', () => {
    expect(packStep({ left: 400, until: 4 }, 300, chicken, 5)).toEqual({
      opened: { left: 300, until: 6 },
      bought: 600,
      used: 300,
      thrown: { left: 400, until: 4 },
    });
  });

  it('finishes the open pack and opens the next for what it cannot give, the new one open after it', () => {
    expect(packStep({ left: 100, until: 4 }, 300, chicken, 4)).toEqual({
      opened: { left: 400, until: 5 },
      bought: 600,
      used: 300,
      thrown: undefined,
    });
  });

  it('takes a spoonful more than the open pack holds from it, and leaves nothing open', () => {
    expect(packStep({ left: 100, until: 4 }, 125, chicken, 4)).toEqual({
      opened: undefined,
      bought: 0,
      used: 100,
      thrown: undefined,
    });
  });
});

describe('what a meal does to the packs of a plan', () => {
  it('holds a pack it opens and mostly leaves against the meal on the last day of a plan', () => {
    // 150 g of 600: three quarters of the pack would be left, with no day to use them on.
    expect(packPull(meal({ chicken: 150 }), open({}), PACKS, 0)).toBeLessThan(-0.6);
    // A meal of a serving and a half of a recipe is one that takes half as much again.
    expect(packPull(meal({ chicken: 100 }), open({}), PACKS, 0, 0, 1.5)).toBe(
      packPull(meal({ chicken: 150 }), open({}), PACKS, 0),
    );
  });

  it('holds it against no meal with a week of the plan to come in which the pack keeps, and the less the more of those days there are', () => {
    const onTheLastDay = packPull(meal({ olives: 40 }), open({}), PACKS, 0);

    expect(DAYS_TO_USE_A_PACK).toBe(7);
    expect(onTheLastDay).toBeLessThan(0);
    expect(packPull(meal({ olives: 40 }), open({}), PACKS, 0, 7)).toBe(0);
    expect(packPull(meal({ olives: 40 }), open({}), PACKS, 0, 30)).toBe(0);
    expect(packPull(meal({ olives: 40 }), open({}), PACKS, 0, 3.5)).toBeCloseTo(
      onTheLastDay / 2,
      5,
    );
    expect(packPull(meal({ olives: 40 }), open({}), PACKS, 0, 6)).toBeGreaterThan(
      packPull(meal({ olives: 40 }), open({}), PACKS, 0, 1),
    );
  });

  it('counts only the days the pack keeps: a pack of chicken opened for 150 g is held against the meal with a week to come', () => {
    const withAWeek = packPull(meal({ chicken: 150 }), open({}), PACKS, 0, 7);
    const withADay = packPull(meal({ chicken: 150 }), open({}), PACKS, 0, 1);

    // It keeps two days: only the next can come back to it.
    expect(withAWeek).toBe(withADay);
    expect(withAWeek).toBeLessThan(-0.5);
  });

  it('holds nothing against a meal that opens a pack and uses it well', () => {
    expect(packPull(meal({ chicken: 500 }), open({}), PACKS, 0)).toBe(0);
  });

  it('is nothing for an ingredient that is bought loose, or whose pack keeps', () => {
    expect(packPull(meal({ rice: 80, tomato: 240 }), open({}), PACKS, 0)).toBe(0);
  });

  it('speaks for a meal that takes from a pack that was mostly left while it keeps', () => {
    // 200 g of 600 are used; a meal of 200 g more brings the pack to two thirds.
    const pull = packPull(
      meal({ chicken: 200 }),
      open({ chicken: { left: 400, until: 3 } }),
      PACKS,
      3,
    );

    expect(pull).toBeGreaterThan(0.4);
    expect(pull).toBeLessThanOrEqual(1);
    expect(
      packPull(meal({ chicken: 200 }), open({ chicken: { left: 400, until: 3 } }), PACKS, 3, 7),
    ).toBe(pull);
  });

  it('speaks against a meal that would take from a pack that no longer keeps: it opens another', () => {
    expect(
      packPull(meal({ chicken: 200 }), open({ chicken: { left: 400, until: 2 } }), PACKS, 3),
    ).toBeLessThan(0);
  });

  it('does not speak for a meal that would finish a pack that is used well enough already', () => {
    // 550 g of 600 are used: the 50 g that are left are no reason to plan anything.
    expect(
      packPull(meal({ chicken: 50 }), open({ chicken: { left: 50, until: 1 } }), PACKS, 1),
    ).toBe(0);
  });

  it('speaks against a meal that would open another pack for what a used one cannot give', () => {
    // 550 g of 600 are used and a meal wants 150 g: a second pack, of which 500 g would be left.
    expect(
      packPull(meal({ chicken: 150 }), open({ chicken: { left: 50, until: 1 } }), PACKS, 1),
    ).toBeLessThan(-0.7);
    // Nine eggs of ten are used and a meal wants three: a second carton for two eggs.
    expect(
      packPull(meal({ eggs: 165 }), open({ eggs: { left: 55, until: 6 } }), PACKS, 1),
    ).toBeLessThan(-0.6);
    // With a week to come, in which a carton keeps, the second has its use.
    expect(packPull(meal({ eggs: 165 }), open({ eggs: { left: 55, until: 6 } }), PACKS, 1, 7)).toBe(
      0,
    );
  });

  it('holds nothing against a meal that takes a spoonful more than a pack holds', () => {
    // 590 g of 600 are used and a meal wants 30 g: the pack does for it.
    expect(
      packPull(meal({ chicken: 30 }), open({ chicken: { left: 10, until: 1 } }), PACKS, 1),
    ).toBe(0);
  });

  it('weighs every ingredient of the meal, and stays between minus one and one', () => {
    const both = packPull(
      meal({ chicken: 200, yogurt: 150 }),
      open({ chicken: { left: 400, until: 1 }, yogurt: { left: 350, until: 6 } }),
      PACKS,
      1,
    );
    const one = packPull(
      meal({ chicken: 200 }),
      open({ chicken: { left: 400, until: 1 }, yogurt: { left: 350, until: 6 } }),
      PACKS,
      1,
    );

    expect(both).toBeGreaterThan(one);
    expect(
      packPull(
        meal({ chicken: 150, eggs: 165, yogurt: 100 }),
        open({
          chicken: { left: 50, until: 1 },
          eggs: { left: 55, until: 6 },
          yogurt: { left: 50, until: 6 },
        }),
        PACKS,
        1,
      ),
    ).toBe(-1);
  });
});

describe('what a plan comes to in packs', () => {
  it('is the whole packs it buys against what it eats of them, day by day', () => {
    const use = packUse(
      daily(3, {
        chicken: [
          [0, 300],
          [1, 580],
        ],
        yogurt: [[2, 500]],
        rice: [[0, 330]],
      }),
      PACKS,
    );

    // Two packs of chicken and one tub of yogurt; the rice is no pack that is counted here.
    expect(use).toMatchObject({ bought: 1700, used: 1380 });
    expect(use.open).toEqual([
      {
        ingredientId: 'chicken',
        packSize: 600,
        packs: 2,
        used: 880,
        left: 320,
        wasted: true,
        until: 2,
        atEnd: true,
      },
    ]);
  });

  it('throws away what a pack holds past its last day, and buys another for a need after it', () => {
    // Chicken keeps two days: what Monday leaves is gone by Thursday.
    const use = packUse(
      daily(5, {
        chicken: [
          [0, 200],
          [3, 200],
        ],
      }),
      PACKS,
    );

    expect(use).toMatchObject({ bought: 1200, used: 400 });
    expect(use.open).toEqual([
      expect.objectContaining({ left: 400, until: 1, atEnd: false, wasted: true, packs: 2 }),
      expect.objectContaining({ left: 400, until: 4, atEnd: true, wasted: true, packs: 2 }),
    ]);
  });

  it('names what is left in each pack of one ingredient, as the plan counts it', () => {
    // Monday opens a pack and leaves 400 g that are gone by Thursday; Thursday's opens another and Friday finishes it.
    const row = [200, 0, 0, 400, 200];
    const left = packsLeftOver(row, PACKS.get('chicken')!);

    expect(left).toEqual([{ left: 400, until: 1 }]);
    expect(packsLeft(packUse(new Map([['chicken', row]]), PACKS))).toBeCloseTo(400 / 600, 6);
    expect(packsLeftOver([0, 0, 0], PACKS.get('chicken')!)).toEqual([]);
  });

  it('eats from one pack on the days it keeps: two meals on two days finish it', () => {
    expect(
      packUse(
        daily(2, {
          chicken: [
            [0, 300],
            [1, 300],
          ],
        }),
        PACKS,
      ),
    ).toEqual({ bought: 600, used: 600, open: [], frozen: [] });
  });

  it('says a pack is still kept when the plan ends on one of its days, and thrown when it ended before', () => {
    const atTheEnd = packUse(daily(4, { yogurt: [[1, 100]] }), PACKS);
    const before = packUse(daily(9, { chicken: [[1, 100]] }), PACKS);

    expect(atTheEnd.open[0]).toMatchObject({ left: 400, until: 7, atEnd: true });
    expect(before.open[0]).toMatchObject({ left: 500, until: 2, atEnd: false });
  });

  it('names a pack that is left open and used well enough, without calling it wasted', () => {
    const use = packUse(daily(1, { chicken: [[0, 550]] }), PACKS);

    expect(use.open).toEqual([
      expect.objectContaining({ ingredientId: 'chicken', left: 50, wasted: false }),
    ]);
  });

  it('puts the pack with the most left first', () => {
    const use = packUse(
      daily(1, {
        chicken: [[0, 550]],
        yogurt: [[0, 100]],
        eggs: [[0, 275]],
      }),
      PACKS,
    );

    expect(use.open.map((pack) => pack.ingredientId)).toEqual(['yogurt', 'eggs', 'chicken']);
  });

  it('takes a need that is a spoonful over its packs for the packs, all of them eaten', () => {
    expect(
      packUse(daily(1, { salmon: [[0, 1008]] }), new Map([['salmon', { size: 250, keepDays: 2 }]])),
    ).toEqual({ bought: 1000, used: 1000, open: [], frozen: [] });
  });

  it('is nothing for a plan that uses nothing that comes in such a pack', () => {
    expect(packUse(daily(2, { rice: [[0, 330]] }), PACKS)).toEqual({
      bought: 0,
      used: 0,
      open: [],
      frozen: [],
    });
    expect(packUse(new Map(), PACKS)).toEqual({ bought: 0, used: 0, open: [], frozen: [] });
  });

  it('comes to what is left in packs, all of it and beyond the accepted fifth of each', () => {
    const use = packUse(
      daily(5, {
        chicken: [
          [0, 200],
          [3, 200],
        ],
        eggs: [[0, 500]],
      }),
      PACKS,
    );

    expect(ACCEPTED_LEFT).toBe(0.2);
    // Two thirds of each chicken pack and a tenth of the carton.
    expect(packsLeft(use)).toBeCloseTo(2 * (400 / 600) + 50 / 550, 5);
    expect(packsLeftBeyondAccepted(use)).toBeCloseTo(2 * (400 / 600 - 0.2), 5);
  });
});

describe('when the packs of fresh meat or fish are bought', () => {
  const chicken = PACKS.get('chicken')!;

  it('ends each pack on the last day it is eaten from, in the order they are opened', () => {
    // Monday opens one and Tuesday finishes it; Thursday takes two whole packs and opens a third that Friday eats from.
    expect(packLastDays([300, 300, 0, 1500, 200], chicken)).toEqual([1, 3, 3, 4]);
    // A pack past its last day is thrown: the next need opens another, that day its own last.
    expect(packLastDays([100, 0, 0, 100], chicken)).toEqual([0, 3]);
    // A spoonful more than the open pack holds finishes it: no new pack.
    expect(packLastDays([300, 320], chicken)).toEqual([1]);
    expect(packLastDays([0, 0], chicken)).toEqual([]);
  });

  it('buys on the first day what keeps until it is eaten, and says from which day the rest is bought', () => {
    // A week: chicken on Monday and Tuesday (one pack), and on Saturday and Sunday (another).
    const week = [300, 300, 0, 0, 0, 300, 300];
    // The second pack is eaten last on Sunday (day 6), and keeps two days: bought from Saturday (day 5) on.
    expect(freshPurchases(week, chicken)).toEqual({ count: 2, later: [{ day: 5, packs: 1 }] });
    // Bought on the first day, a pack keeps on the second as well: nothing later for Monday and Tuesday.
    expect(freshPurchases([300, 300], chicken)).toEqual({ count: 1, later: [] });
    // Two packs on Thursday, both from Wednesday on at the earliest.
    expect(freshPurchases([0, 0, 0, 1200], chicken)).toEqual({
      count: 2,
      later: [{ day: 2, packs: 2 }],
    });
  });

  it('counts a pack for each need the pack before no longer keeps for, where one pack would hold both', () => {
    // 100 g on Monday and on Thursday: one pack would hold both, but Monday's is gone by Thursday.
    expect(freshPurchases([100, 0, 0, 100], chicken)).toEqual({
      count: 2,
      later: [{ day: 2, packs: 1 }],
    });
  });

  it('counts what is at home first, from the first day on', () => {
    // 600 g at home cover Monday and Tuesday: what is bought is for the weekend.
    expect(freshPurchases([300, 300, 0, 0, 0, 300, 300], chicken, 600)).toEqual({
      count: 1,
      later: [{ day: 5, packs: 1 }],
    });
    // Enough at home for the whole week: nothing to buy.
    expect(freshPurchases([300, 300, 0, 0, 0, 300, 300], chicken, 1200)).toEqual({
      count: 0,
      later: [],
    });
    // What is at home covers the first need only: the weekend's pack is still bought later.
    expect(freshPurchases([300, 0, 0, 0, 0, 0, 300], chicken, 300)).toEqual({
      count: 1,
      later: [{ day: 5, packs: 1 }],
    });
  });
});

describe('a pack that freezes, as meat and fish in a plan that wastes nothing', () => {
  /** Chicken in packs of 600 g that keep two days, put in the freezer for what is not eaten fresh. */
  const chicken: Pack = { size: 600, keepDays: 2, freezes: true };
  const row = (days: number, needs: [number, number][]) => {
    const out = Array.from({ length: days }, () => 0);
    for (const [day, amount] of needs) out[day]! += amount;
    return out;
  };

  it('puts what the plan does not eat while the pack keeps in the freezer, on the day it is opened, and throws nothing away', () => {
    const walked = freezerWalk(
      row(7, [
        [0, 250],
        [1, 150],
      ]),
      chicken,
    );

    expect(walked).toMatchObject({ bought: 600, eaten: 400 });
    expect(walked.frozen).toEqual([{ day: 0, amount: 200, thawed: [] }]);
    const use = packUse(
      new Map([
        [
          'chicken',
          row(7, [
            [0, 250],
            [1, 150],
          ]),
        ],
      ]),
      new Map([['chicken', chicken]]),
    );
    expect(use.open).toEqual([]);
    expect(use.frozen).toEqual([
      { ingredientId: 'chicken', packSize: 600, day: 0, amount: 200, thawed: [] },
    ]);
  });

  it('takes a need after the pack no longer keeps from the freezer before a pack is bought, the day after it went in at the soonest', () => {
    const walked = freezerWalk(
      row(7, [
        [0, 250],
        [4, 200],
        [5, 300],
      ]),
      chicken,
    );

    // Day 4 takes 200 of the 350 frozen; day 5 takes the other 150 and opens a pack for the rest of its 300.
    expect(walked.frozen[0]).toEqual({
      day: 0,
      amount: 350,
      thawed: [
        { day: 4, amount: 200 },
        { day: 5, amount: 150 },
      ],
    });
    expect(frozenLeft(walked.frozen[0]!)).toBe(0);
    expect(walked.bought).toBe(1200);
    // The second pack, opened on day 5 for 150 g, keeps its 450 g to the end: frozen too.
    expect(walked.frozen[1]).toEqual({ day: 5, amount: 450, thawed: [] });
  });

  it('freezes no rest under a spoonful of its pack', () => {
    expect(freezerWalk(row(3, [[0, 580]]), chicken).frozen).toEqual([]);
  });

  it('counts as a pack does without a freezer where the plan eats every pack fresh', () => {
    const needs = row(4, [
      [0, 300],
      [1, 300],
      [2, 600],
    ]);
    const plain = packUse(
      new Map([['chicken', needs]]),
      new Map([['chicken', { size: 600, keepDays: 2 }]]),
    );
    const freezing = packUse(new Map([['chicken', needs]]), new Map([['chicken', chicken]]));

    expect(freezing).toEqual({ ...plain, frozen: [] });
  });

  it('is counted as it leaves its packs where the count asks without the freezer: what a rest or a closing could still eat', () => {
    const needs = new Map([['chicken', row(7, [[0, 250]])]]);
    const use = packUse(needs, new Map([['chicken', chicken]]), false);

    expect(use.frozen).toEqual([]);
    expect(use.open).toMatchObject([{ ingredientId: 'chicken', left: 350 }]);
  });

  it('buys later only the packs that are eaten fresh: a need the freezer feeds buys nothing', () => {
    // A pack on day 0, and on day 4 what the freezer holds is enough.
    expect(
      packLastDays(
        row(7, [
          [0, 250],
          [4, 300],
        ]),
        chicken,
      ),
    ).toEqual([0]);
    expect(
      freshPurchases(
        row(7, [
          [0, 250],
          [4, 300],
        ]),
        chicken,
      ),
    ).toEqual({ count: 1, later: [] });
    // Without the freezer the day 4 need opens a pack of its own, bought from day 3.
    expect(
      freshPurchases(
        row(7, [
          [0, 250],
          [4, 300],
        ]),
        { size: 600, keepDays: 2 },
      ),
    ).toEqual({
      count: 2,
      later: [{ day: 3, packs: 1 }],
    });
  });
});

describe('a portion held in the freezer', () => {
  it('comes out whole for the first day from its own on that needs it, and is eaten within two days', () => {
    expect(thawHeld([0, 150, 100, 200], { amount: 286, from: 0 })).toEqual({
      day: 1,
      eaten: 250,
      left: 36,
      rest: [0, 0, 0, 200],
    });
    expect(thawHeld([0, 150, 200], { amount: 300, from: 0 })).toEqual({
      day: 1,
      eaten: 300,
      left: 0,
      rest: [0, 0, 50],
    });
  });

  it('stays frozen where no day from its own on needs the food', () => {
    expect(thawHeld([150, 0, 0], { amount: 286, from: 1 })).toBeNull();
  });
});

describe('packages held in the freezer', () => {
  it('come out one after another, each for the first day that still needs the food once those before it are eaten', () => {
    // 250 g a day: the first package eats day 0 and 50 g of day 1, the second the 200 g left of day 1 and 100 g of day 2.
    expect(
      thawAll(
        [250, 250, 250, 250],
        [
          { amount: 300, from: 0 },
          { amount: 300, from: 0 },
        ],
      ),
    ).toEqual({
      thawed: [
        { day: 0, eaten: 300, left: 0 },
        { day: 1, eaten: 300, left: 0 },
      ],
      rest: [0, 0, 150, 250],
    });
  });

  it('stay frozen once no day needs the food any more', () => {
    expect(
      thawAll(
        [200, 0, 0],
        [
          { amount: 200, from: 0 },
          { amount: 200, from: 0 },
        ],
      ),
    ).toEqual({ thawed: [{ day: 0, eaten: 200, left: 0 }, null], rest: [0, 0, 0] });
  });

  it('are taken out only where the days eat them whole: a larger one stays frozen, and the next is looked at', () => {
    // 150 g and 100 g on days 1 and 2: of a kilogram 750 g would be left, so it stays; the 250 g after it comes out.
    expect(
      packagesTaken(
        [0, 150, 100, 0, 0],
        [
          { amount: 1000, from: 0 },
          { amount: 250, from: 0 },
        ],
      ),
    ).toEqual([1]);
    // Two of 250 g for 150 g a day over four days: the first eats day 0 and 100 g of day 1; taken out on day 1 the
    // second would be left 50 g, so it comes out for day 2, whose day and the next eat it whole.
    const twoOf250 = [
      { amount: 250, from: 0 },
      { amount: 250, from: 0 },
    ];
    expect(packagesTaken([150, 150, 150, 150], twoOf250)).toEqual([0, 1]);
    expect(thawAll([150, 150, 150, 150], twoOf250)).toEqual({
      thawed: [
        { day: 0, eaten: 250, left: 0 },
        { day: 2, eaten: 250, left: 0 },
      ],
      rest: [0, 50, 0, 50],
    });
  });

  it('come out, where no two days eat them whole, for the first day that needs the food, and say what is left', () => {
    expect(thawAll([0, 150, 100, 0], [{ amount: 1000, from: 0 }])).toEqual({
      thawed: [{ day: 1, eaten: 250, left: 750 }],
      rest: [0, 0, 0, 0],
    });
    expect(packagesTaken([0, 150, 100, 0], [{ amount: 1000, from: 0 }])).toEqual([]);
  });

  // 220 g of bacon frozen, and five breakfasts of 44, 85, 45, 43 and 68 g: no day and the next eat it whole.
  const breakfasts = [43.65, 84.9, 45, 42.75, 67.5, 0, 0];

  it('stay frozen where no two days eat them whole and their date is far', () => {
    expect(packagesTaken(breakfasts, [{ amount: 220, from: 0 }])).toEqual([]);
  });

  it('come out, dated soon, for the day whose day and the next eat the most of them, and say what is left', () => {
    const dueSoon = [{ amount: 220, from: 0, due: true }];

    expect(packagesTaken(breakfasts, dueSoon)).toEqual([0]);
    expect(thawAll(breakfasts, dueSoon)).toEqual({
      thawed: [{ day: 1, eaten: 129.9, left: 90.1 }],
      rest: [43.65, 0, 0, 42.75, 67.5, 0, 0],
    });
    // Dated soon and eaten whole on some day and the next, it comes out for those as any package does.
    expect(thawAll([150, 150, 150], [{ amount: 250, from: 0, due: true }]).thawed).toEqual([
      { day: 0, eaten: 250, left: 0 },
    ]);
  });

  it('stay frozen, dated soon, where no day from their own on needs the food', () => {
    expect(packagesTaken([150, 0, 0], [{ amount: 220, from: 1, due: true }])).toEqual([]);
  });
});

describe('a package of the freezer dated soon', () => {
  it('is one dated within the plan or a week after its last day', () => {
    expect(isDueSoon('2026-11-25', '2026-11-29')).toBe(true);
    expect(isDueSoon('2026-12-06', '2026-11-29')).toBe(true);
    expect(isDueSoon('2026-12-07', '2026-11-29')).toBe(false);
    expect(isDueSoon(null, '2026-11-29')).toBe(false);
  });
});
