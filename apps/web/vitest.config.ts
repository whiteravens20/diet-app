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
    },
  },
});
