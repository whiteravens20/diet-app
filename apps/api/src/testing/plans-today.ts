// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What day it is for the service of the plans in a test: the first day of the
 * plans of the tests, on which a meal can be marked as eaten and a day has not
 * passed. A test about another day says so, for that test alone.
 */
let today = '2026-01-05';

export const plansToday = (): string => today;

/** Let `date` be today for the service of the plans, until the test ends. */
export function plansTodayIs(date: string): void {
  today = date;
}

/** Start from the first day again: before every test. */
export function restartPlansToday(): void {
  today = '2026-01-05';
}
