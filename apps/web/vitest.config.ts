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
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      // Exclude generated/Next-runtime and pure type modules from the denominator.
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/app/**/{layout,loading,error,not-found,template,default,manifest}.{ts,tsx}',
        'src/i18n/**',
      ],
    },
  },
});
