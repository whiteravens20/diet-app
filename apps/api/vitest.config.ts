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
          // Every answer of a test application is held to what its route declares.
          setupFiles: ['src/testing/hold-answers.ts', 'src/testing/pinned-seeds.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      // `benchmark` measures the server against its performance budgets, on
      // the same database. It is run by itself (`npm run bench`), never under
      // coverage: an instrumented run is not what the budgets are about.
      {
        test: {
          name: 'benchmark',
          include: ['src/**/*.bench.ts'],
          environment: 'node',
          globals: true,
          globalSetup: ['src/testing/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 600_000,
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
      // A floor is what the suites reach today, less a point: a change that
      // leaves code untested shows as its directory under the floor. A floor
      // goes up when a suite lands and is not lowered to let a change through.
      // The directories too small for a percentage to mean much share one
      // floor. In the files where a mistake costs the most (sessions, keys,
      // what is dialled for a user) a test runs every function and every line,
      // but for one that only passes an error on that nobody expects.
      thresholds: {
        lines: 93,
        functions: 94,
        branches: 83,
        statements: 92,
        'src/admin/**': { lines: 88, functions: 89, branches: 77, statements: 86 },
        'src/ai/**': { lines: 95, functions: 96, branches: 85, statements: 94 },
        'src/auth/**': { lines: 98, functions: 98, branches: 90, statements: 97 },
        'src/common/**': { lines: 97, functions: 99, branches: 90, statements: 96 },
        'src/engine/**': { lines: 98, functions: 99, branches: 92, statements: 97 },
        'src/favorite-sets/**': { lines: 93, functions: 99, branches: 75, statements: 91 },
        'src/meal-plans/**': { lines: 95, functions: 95, branches: 82, statements: 92 },
        'src/recipes/**': { lines: 95, functions: 98, branches: 90, statements: 95 },
        'src/shopping-lists/**': { lines: 95, functions: 96, branches: 78, statements: 91 },
        'src/users/**': { lines: 98, functions: 99, branches: 85, statements: 97 },
        'src/{app-config,catalogue,config,favorites,health,ingredients,instance-settings,inventory,mail,notifications,policy-reports,prisma,profiles,rate-limit,review,weights}/**': {
          lines: 96,
          functions: 94,
          branches: 88,
          statements: 95,
        },
        'src/admin/admin-session.ts': { lines: 100, functions: 100 },
        'src/ai/ai-key.service.ts': { lines: 98, functions: 100 },
        'src/ai/ai-quota.service.ts': { lines: 100, functions: 100 },
        'src/ai/key-cipher.ts': { lines: 100, functions: 100 },
        'src/ai/ollama-url.ts': { lines: 100, functions: 100 },
        'src/auth/auth.service.ts': { lines: 100, functions: 100 },
        'src/auth/sessions.service.ts': { lines: 100, functions: 100 },
        'src/auth/turnstile.service.ts': { lines: 100, functions: 100 },
        'src/common/crypto.ts': { lines: 100, functions: 100 },
        'src/common/outbound-http.ts': { lines: 100, functions: 100 },
        'src/common/public-address.ts': { lines: 100, functions: 100 },
        'src/review/session.ts': { lines: 100, functions: 100 },
      },
    },
  },
});
