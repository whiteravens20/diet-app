// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Loaded before every file of integration tests: each test makes its plans
 * with the same seeds, whatever ran before it (`seeds.ts`).
 */
import { beforeEach } from 'vitest';
import { restartSeeds } from './seeds.js';

beforeEach(() => {
  restartSeeds();
});
