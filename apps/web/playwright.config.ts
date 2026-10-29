// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { defineConfig, devices } from '@playwright/test';
import type { Options } from './e2e/fixtures';

/**
 * The tests that need a browser. They run against an instance that is up:
 * `E2E_BASE_URL` names its web address, and `E2E_ADMIN_USER` with
 * `E2E_ADMIN_PASSWORD` let them into the admin panel (left out, the panel's
 * tests are skipped). Nothing here starts the application.
 *
 * A project is one reader: a language, a size of screen, light or dark, and
 * the engine of a browser. The tests of a project share one account and one
 * browser session and change what the next one finds, so they run one at a
 * time.
 */
const desktop = { width: 1280, height: 800 };
const phone = { width: 375, height: 667 };

export default defineConfig<Options>({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A page is judged as it stands, not while a tile is still fading in. That
    // the application keeps still for somebody who asks it to has a test of its own.
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop-en', use: { viewport: desktop, appLocale: 'en' } },
    { name: 'desktop-pl', use: { viewport: desktop, appLocale: 'pl' } },
    { name: 'phone-en', use: { viewport: phone, appLocale: 'en', hasTouch: true, isMobile: true } },
    { name: 'phone-pl', use: { viewport: phone, appLocale: 'pl', hasTouch: true, isMobile: true } },
    { name: 'desktop-en-dark', use: { viewport: desktop, appLocale: 'en', colorScheme: 'dark' } },
    // Safari's engine on an iPhone's screen, in Polish: what Chromium lets through and WebKit does not.
    { name: 'iphone-pl', use: { ...devices['iPhone 17'], appLocale: 'pl' } },
  ],
});
