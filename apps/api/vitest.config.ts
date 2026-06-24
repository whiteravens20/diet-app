// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      // Exclude tests, entrypoints, Nest wiring and pure type/contract modules
      // from the denominator — they carry no branch logic to cover.
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/worker.ts',
        'src/**/*.module.ts',
        'src/**/*.dto.ts',
        'src/**/index.ts',
      ],
      // Floors are ratcheted up as suites land; never lowered — that is the
      // regression gate. The engine carries the deterministic math, so it holds
      // the spec's strictest floor. Branches sit at 85 (today's real number is
      // ~88) pending deeper optimizer/rebalance branch tests; ratchet toward 90.
      thresholds: {
        'src/engine/**': { lines: 95, functions: 95, branches: 85, statements: 95 },
      },
    },
  },
});
