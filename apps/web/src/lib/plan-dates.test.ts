// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { MAX_CALENDAR_DAYS } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { monthAfter, monthOf, planDates, weeksOf } from './plan-dates';

describe('the days of a plan', () => {
  it('are as many as the plan is long, from its first day on, over the end of a month', () => {
    expect(planDates('2026-01-30', 4)).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
    expect(planDates('not a day', 3)).toEqual([]);
    expect(planDates('2026-01-30', 0)).toEqual([]);
  });
});

describe('the months a calendar leafs through', () => {
  it('begin on their first day', () => {
    expect(monthOf('2026-01-31')).toBe('2026-01-01');
    expect(monthOf('2026-02-01')).toBe('2026-02-01');
  });

  it('follow one another over the end of a year, forwards and back', () => {
    expect(monthAfter('2026-01-15', 1)).toBe('2026-02-01');
    expect(monthAfter('2026-12-01', 1)).toBe('2027-01-01');
    expect(monthAfter('2026-01-01', -1)).toBe('2025-12-01');
    expect(monthAfter('2026-03-31', -1)).toBe('2026-02-01');
  });
});

describe('the weeks a month is drawn in', () => {
  it('begin on the Monday on or before its first day and end on the Sunday on or after its last', () => {
    // January 2026 begins on a Thursday and ends on a Saturday.
    const january = weeksOf('2026-01-01');

    expect(january).toHaveLength(5);
    expect(january[0]).toEqual(['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    expect(january.at(-1)).toEqual(['2026-01-26', '2026-01-27', '2026-01-28', '2026-01-29', '2026-01-30', '2026-01-31', '2026-02-01']);
  });

  it('are four for a February that begins on a Monday, and six for a long month that begins on a Sunday', () => {
    // February 2027 begins on a Monday and has 28 days.
    expect(weeksOf('2027-02-01')).toHaveLength(4);
    expect(weeksOf('2027-02-01')[0]![0]).toBe('2027-02-01');
    expect(weeksOf('2027-02-01').at(-1)![6]).toBe('2027-02-28');
    // March 2026 begins on a Sunday and has 31 days.
    expect(weeksOf('2026-03-01')).toHaveLength(6);
    expect(weeksOf('2026-03-01')[0]![0]).toBe('2026-02-23');
    expect(weeksOf('2026-03-01').at(-1)![6]).toBe('2026-04-05');
  });

  it('are never more days than a calendar of plans is asked for at once', () => {
    for (let months = 0; months < 48; months += 1) {
      expect(weeksOf(monthAfter('2026-01-01', months)).flat().length).toBeLessThanOrEqual(MAX_CALENDAR_DAYS);
    }
  });

  it('are those of the month whatever day of it they are asked by', () => {
    expect(weeksOf('2026-01-17')).toEqual(weeksOf('2026-01-01'));
  });
});
