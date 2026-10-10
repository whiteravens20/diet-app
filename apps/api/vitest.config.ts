// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Two projects. `unit` needs nothing but Node. `integration` starts the real
    // application on a PostgreSQL database (see src/testing/database.ts) and runs
    // its files one after another, because they share that database.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
          environment: 'node',
          globals: true,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          environment: 'node',
          globals: true,
          globalSetup: ['src/testing/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      // Exclude tests, entrypoints, Nest wiring and pure type/contract modules
      // from the denominator — they carry no branch logic to cover.
      exclude: [
        'src/**/*.test.ts',
        'src/testing/**',
        'src/main.ts',
        'src/worker.ts',
        'src/**/*.module.ts',
        'src/**/*.dto.ts',
        'src/**/index.ts',
      ],
      // Floors are ratcheted up as suites land; never lowered — that is the
      // regression gate. The global floor is set at today's measured number;
      // the engine carries the deterministic math at the strict floor; the
      // directories with service suites hold interim per-file floors so their
      // gains can't erode while the large orchestration services (meal-plans,
      // shopping-lists, recipes) are still being covered toward the 85% target.
      thresholds: {
        lines: 71,
        functions: 75,
        branches: 60,
        statements: 70,
        'src/engine/**': { lines: 95, functions: 95, branches: 85, statements: 95 },
        'src/ai/ai-key.service.ts': { lines: 85, functions: 80, branches: 60, statements: 85 },
        'src/ai/ai-quota.service.ts': { lines: 95, functions: 95, branches: 75, statements: 95 },
        'src/ai/ollama-url.ts': { lines: 94, functions: 95, branches: 90, statements: 94 },
        'src/auth/auth.service.ts': { lines: 78, functions: 70, branches: 60, statements: 78 },
        'src/auth/turnstile.service.ts': { lines: 90, functions: 100, branches: 87, statements: 90 },
        'src/favorites/favorites.service.ts': { lines: 95, functions: 95, branches: 80, statements: 95 },
        'src/inventory/**': { lines: 95, functions: 95, branches: 82, statements: 93 },
        'src/rate-limit/**': { lines: 95, functions: 85, branches: 75, statements: 93 },
        'src/recipes/personal-recipes.service.ts': { lines: 92, functions: 95, branches: 82, statements: 92 },
        'src/shopping-lists/shopping-lists.service.ts': { lines: 88, functions: 95, branches: 66, statements: 86 },
        'src/profiles/profiles.service.ts': { lines: 75, functions: 75, branches: 90, statements: 75 },
        'src/weights/weights.service.ts': { lines: 95, functions: 95, branches: 90, statements: 95 },
        'src/ingredients/ingredients.service.ts': { lines: 95, functions: 95, branches: 75, statements: 95 },
      },
    },
  },
});
