// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the tsconfig `@/*` → `src/*` alias.
    alias: { '@': srcDir },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // A moment is shown by the reader's clock: the tests read theirs in UTC,
    // whatever the zone of the machine they run on.
    env: { TZ: 'UTC' },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      // Exclude generated/Next-runtime and pure type modules from the denominator.
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/testing/**',
        'src/**/*.d.ts',
        'src/app/**/{layout,loading,error,not-found,template,default,manifest}.{ts,tsx}',
        'src/i18n/**',
      ],
      // A floor is what the tests reach today, less a point. The pages are
      // tested in a browser as well (`e2e/`), which is not counted here: what
      // these floors hold is that the logic and the components stay tested
      // without one. The primitives every page is built from are tested whole.
      thresholds: {
        lines: 59,
        functions: 54,
        branches: 60,
        statements: 59,
        'src/lib/**': { lines: 80, functions: 73, branches: 78, statements: 80 },
        'src/components/**': { lines: 67, functions: 58, branches: 68, statements: 66 },
        'src/components/ui/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/app/**': { lines: 52, functions: 49, branches: 54, statements: 52 },
      },
    },
  },
});
