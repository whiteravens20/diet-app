// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Loaded before every file of integration tests: each test makes its plans
 * with the same seeds, whatever ran before it (`seeds.ts`), and begins on the
 * same day for the service of the plans (`plans-today.ts`).
 */
import { beforeEach } from 'vitest';
import { restartPlansToday } from './plans-today.js';
import { restartSeeds } from './seeds.js';

beforeEach(() => {
  restartSeeds();
  restartPlansToday();
});
