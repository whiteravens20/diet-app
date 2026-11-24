// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { chooseAgain, packageKey, packagesDue, type KitchenPackage } from './freezer-repick.js';

const CHICKEN = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';
const LAST_DAY = '2026-11-29';

/** A package of chicken in the plan's profile's freezer, not taken, eaten from the second day on, unless `over` says otherwise. */
const aPackage = (over: Partial<KitchenPackage> = {}): KitchenPackage => ({
  planId: PLAN,
  ingredientId: CHICKEN,
  parcel: 2,
  amount: 340,
  bestBefore: '2026-12-20',
  from: 1,
  taken: false,
  held: true,
  ...over,
});
const needs = (row: number[]) => new Map([[CHICKEN, row]]);
const parcels = (chosen: KitchenPackage[]) => chosen.map((one) => [one.parcel, one.from]);

describe('the packages a plan takes out of the freezer, chosen again after a change', () => {
  it('takes a package a day and the next now eat whole, from tomorrow on', () => {
    // A lunch that grew to 413 g of chicken eats the whole 340 g package.
    const chosen = chooseAgain(
      needs([0, 413, 0, 314, 0, 0, 0]),
      [aPackage()],
      1,
      LAST_DAY,
      new Set(),
    );
    expect(parcels(chosen)).toEqual([[2, 1]]);
    expect(chosen[0]!.taken).toBe(true);
  });

  it('leaves frozen a package no day and the next eat whole', () => {
    expect(chooseAgain(needs([0, 300, 0, 0, 0]), [aPackage()], 1, LAST_DAY, new Set())).toEqual([]);
  });

  it('takes no package for today: what it eats today should have come out yesterday', () => {
    expect(chooseAgain(needs([0, 413, 0, 0, 0]), [aPackage()], 2, LAST_DAY, new Set())).toEqual([]);
  });

  it('keeps a package it said to take out by today, whatever the change did to the menu', () => {
    const taken = aPackage({ taken: true, from: 0 });
    const chosen = chooseAgain(
      needs([0, 0, 0, 0, 0]),
      [taken],
      1,
      LAST_DAY,
      new Set([packageKey(taken)]),
    );
    expect(parcels(chosen)).toEqual([[2, 0]]);
  });

  it('lets go a package taken for a later day that the menu no longer eats whole', () => {
    const taken = aPackage({ taken: true, from: 0 });
    expect(chooseAgain(needs([0, 0, 0, 100, 0]), [taken], 1, LAST_DAY, new Set())).toEqual([]);
  });

  it('keeps a package taken that is no longer in the freezer: it was taken out, or a list took it', () => {
    const gone = aPackage({ taken: true, held: false, from: 0 });
    expect(parcels(chooseAgain(needs([0, 0, 0, 0]), [gone], 1, LAST_DAY, new Set()))).toEqual([
      [2, 0],
    ]);
  });

  it('takes nothing anew on a plan with no day after today, and keeps what it took', () => {
    const taken = aPackage({ taken: true, from: 0, parcel: 1 });
    const chosen = chooseAgain(
      needs([400, 400]),
      [taken, aPackage({ parcel: 3 })],
      -1,
      LAST_DAY,
      new Set(),
    );
    expect(parcels(chosen)).toEqual([[1, 0]]);
  });

  it('takes the package going off first first', () => {
    const later = aPackage({ parcel: 5, amount: 200, bestBefore: '2026-12-30' });
    const sooner = aPackage({ parcel: 6, amount: 200, bestBefore: '2026-12-10' });
    expect(
      parcels(chooseAgain(needs([0, 200, 0, 0]), [later, sooner], 1, LAST_DAY, new Set())),
    ).toEqual([[6, 1]]);
  });

  it('takes a package dated soon for the days that eat the most of it, even where they do not eat it whole', () => {
    const soon = aPackage({ bestBefore: '2026-12-02' });
    expect(parcels(chooseAgain(needs([0, 100, 0, 0]), [soon], 1, LAST_DAY, new Set()))).toEqual([
      [2, 1],
    ]);
  });

  it('says a package taken is due by today where the menu eats it first by tomorrow, and not before then', () => {
    const tomorrows = aPackage({ taken: true, from: 0, parcel: 1, amount: 100 });
    const later = aPackage({ taken: true, from: 0, parcel: 2, amount: 100 });
    // The first is eaten on the second day, tomorrow; the second only on the fourth.
    const due = packagesDue(needs([0, 100, 0, 100]), [tomorrows, later], 1);
    expect([...due]).toEqual([packageKey(tomorrows)]);
    expect(packagesDue(needs([0, 100, 0, 100]), [tomorrows, later], -1).size).toBe(0);
  });
});
