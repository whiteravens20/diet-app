import { describe, expect, it } from 'vitest';
import {
  rebalanceDay,
  rebalanceWeek,
  type RebalanceMeal,
  type RebalanceWeekDay,
} from './rebalance.js';

function meal(
  id: string,
  calories: number,
  opts: Partial<Omit<RebalanceMeal, 'id' | 'calories'>> = {},
): RebalanceMeal {
  return {
    id,
    calories,
    servings: opts.servings ?? 1,
    quantityScale: opts.quantityScale ?? 1,
    locked: opts.locked ?? false,
  };
}

const dayKcal = (meals: RebalanceMeal[], scales: Map<string, number>) =>
  meals.reduce((s, m) => s + m.calories * m.servings * (scales.get(m.id) ?? m.quantityScale), 0);

describe('rebalanceDay (F22 quantity rebalancer)', () => {
  it('leaves a day already inside the ±10% window untouched', () => {
    const meals = [meal('a', 700), meal('b', 700), meal('c', 650)]; // 2050 vs 2000 → 2.5%
    const { scales, feasibility } = rebalanceDay(meals, 2000);
    expect(feasibility).toBe('in-window');
    expect([...scales.values()]).toEqual([1, 1, 1]); // no churn
  });

  it('scales unlocked meals down to pull an over-target day back into the window', () => {
    const meals = [meal('a', 1000), meal('b', 1000), meal('c', 1000)]; // 3000 vs 2000 → +50%
    const { scales, feasibility } = rebalanceDay(meals, 2000);
    expect(feasibility).toBe('in-window');
    expect(dayKcal(meals, scales)).toBeCloseTo(2000, 5);
    // uniform factor preserves relative proportions
    expect(scales.get('a')).toBeCloseTo(2 / 3, 5);
    expect(scales.get('a')).toBeCloseTo(scales.get('b')!, 5);
  });

  it('scales unlocked meals up to close a deficit (the ±20% case)', () => {
    const meals = [meal('a', 800), meal('b', 800)]; // 1600 vs 2000 → -20%
    const { scales, feasibility } = rebalanceDay(meals, 2000);
    expect(feasibility).toBe('in-window');
    expect(dayKcal(meals, scales)).toBeCloseTo(2000, 5);
  });

  it('pins eaten / custom meals and only scales the rest', () => {
    const meals = [
      meal('eaten', 1300, { locked: true }),
      meal('flex', 1000),
    ]; // 2300 vs 2000 → +15% (outside): eaten fixed at 1300, flex must become 700
    const { scales, feasibility } = rebalanceDay(meals, 2000);
    expect(feasibility).toBe('in-window');
    expect(scales.get('eaten')).toBe(1); // untouched
    expect(scales.get('flex')).toBeCloseTo(0.7, 5);
    expect(dayKcal(meals, scales)).toBeCloseTo(2000, 5);
  });

  it('returns best-effort when an impossible gap cannot be closed', () => {
    // A 2600 kcal locked custom meal already overshoots a 2000 target; the lone
    // flex meal can only scale down to SERVING_MIN (0.5), never below zero.
    const meals = [
      meal('huge', 2600, { locked: true }),
      meal('flex', 600),
    ];
    const { scales, feasibility } = rebalanceDay(meals, 2000);
    expect(feasibility).toBe('best-effort');
    expect(scales.get('flex')).toBeCloseTo(0.5, 5); // clamped to the floor
    expect(dayKcal(meals, scales)).toBeGreaterThan(2000 * 1.1);
  });

  it('is a no-op (best-effort) when every meal on the day is locked', () => {
    const meals = [meal('a', 1500, { locked: true }), meal('b', 1500, { locked: true })];
    const { scales, feasibility } = rebalanceDay(meals, 2000);
    expect(feasibility).toBe('best-effort');
    expect([...scales.values()]).toEqual([1, 1]);
  });

  it('respects the per-meal serving clamp and redistributes the residual', () => {
    // 'small' starts at 0.5 servings → can scale up to 6× (3.0 servings cap),
    // 'big' starts at 2 servings → capped at 1.5× (3.0 servings). Target forces
    // 'big' to clamp; 'small' must absorb the residual.
    const meals = [meal('big', 500, { servings: 2 }), meal('small', 500, { servings: 0.5 })];
    // Max achievable = both at 3 servings = 1500 + 1500 = 3000. A 3500 target is
    // out of reach: both clamp to the 3-serving ceiling, landing best-effort.
    const target = 3500;
    const { scales, feasibility } = rebalanceDay(meals, target);
    const bigServings = 2 * scales.get('big')!;
    const smallServings = 0.5 * scales.get('small')!;
    expect(bigServings).toBeCloseTo(3, 5); // clamped to the ceiling
    expect(smallServings).toBeCloseTo(3, 5);
    expect(feasibility).toBe('best-effort'); // can't reach 3500 within the band
  });
});

describe('rebalanceWeek (F22 week-aware redistribution)', () => {
  it('shares a single day overshoot across the whole week', () => {
    // Monday carries a locked 1500 custom meal on a 2000 target; the other days
    // are at target. Week mode pulls the week total to 6000 by shrinking every
    // unlocked meal proportionally.
    const days: RebalanceWeekDay[] = [
      { target: 2000, meals: [meal('mon-c', 1500, { locked: true }), meal('mon-f', 1000)] },
      { target: 2000, meals: [meal('tue-f', 2000)] },
      { target: 2000, meals: [meal('wed-f', 2000)] },
    ];
    const { scales } = rebalanceWeek(days);
    const weekTotal = days.reduce((s, d) => s + dayKcal(d.meals, scales), 0);
    expect(weekTotal).toBeCloseTo(6000, 4); // week target hit
    // the locked Monday meal is untouched
    expect(scales.get('mon-c')).toBe(1);
  });

  it('leaves an already-balanced week untouched', () => {
    const days: RebalanceWeekDay[] = [
      { target: 2000, meals: [meal('a', 2000)] },
      { target: 2000, meals: [meal('b', 1950)] },
    ];
    const { scales, feasibility } = rebalanceWeek(days);
    expect(feasibility).toBe('in-window');
    expect([...scales.values()]).toEqual([1, 1]);
  });
});
