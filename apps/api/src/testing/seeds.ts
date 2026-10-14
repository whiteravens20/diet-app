// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The seeds the plans of a test are made with: 1, 2, 3 and on from the start
 * of every test, in the place of the random ones of a running instance. A test
 * then makes the same plans each time it runs, alone or among the others.
 */
let made = 0;

/** The seed of the next plan a test makes. */
export function nextSeed(): number {
  made += 1;
  return made;
}

/** Start the seeds again from the first: before every test. */
export function restartSeeds(): void {
  made = 0;
}
