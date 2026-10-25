// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { VARIETY_DEPTH } from '@diet-app/shared/constants';
import { aDepth } from '@/testing/public-config';
import { supplyOf } from './catalogue';

const depth = aDepth(9);
depth.vegan = { 2: VARIETY_DEPTH, 3: VARIETY_DEPTH - 1, 4: 1, 5: 0 };
depth.keto = { 2: 0, 3: 0, 4: 0, 5: 0 };
depth.mediterranean = { 2: 4, 3: 0, 4: 0, 5: 0 };

describe('how well the catalogue serves a diet at a number of meals a day', () => {
  it('is none when one of the meals has no recipe', () => {
    expect(supplyOf(depth, 'vegan', 5)).toMatchObject({ supply: 'none', recipes: 0 });
  });

  it('is thin under what a week without too many repeats needs', () => {
    expect(supplyOf(depth, 'vegan', 4)).toMatchObject({ supply: 'thin', recipes: 1 });
    expect(supplyOf(depth, 'vegan', 3)).toMatchObject({ supply: 'thin', recipes: VARIETY_DEPTH - 1 });
  });

  it('is enough from there on', () => {
    expect(supplyOf(depth, 'vegan', 2)).toMatchObject({ supply: 'enough', recipes: VARIETY_DEPTH });
    expect(supplyOf(depth, 'balanced', 5)).toMatchObject({ supply: 'enough', recipes: 9 });
  });

  it('names the largest smaller number of meals a day that can be planned', () => {
    expect(supplyOf(depth, 'vegan', 5)!.fewerMeals).toBe(4);
    expect(supplyOf(depth, 'mediterranean', 5)!.fewerMeals).toBe(2);
    expect(supplyOf(depth, 'mediterranean', 3)!.fewerMeals).toBe(2);
  });

  it('names none when fewer meals would not help: the meal without a recipe is part of every day', () => {
    expect(supplyOf(depth, 'keto', 5)!.fewerMeals).toBeNull();
    expect(supplyOf(depth, 'mediterranean', 2)!.fewerMeals).toBeNull();
  });

  it('is not given before the catalogue answered, or for a number of meals nobody can have', () => {
    expect(supplyOf(undefined, 'vegan', 3)).toBeNull();
    expect(supplyOf(depth, 'vegan', 6)).toBeNull();
    expect(supplyOf(depth, 'vegan', Number.NaN)).toBeNull();
  });
});
