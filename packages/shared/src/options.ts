// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The values some settings choose from, as plain lists. The schemas that
 * check them are built on these lists (`settings.ts`), so one place says
 * which languages and palettes there are.
 *
 * This file needs nothing else of the contract. Code that only has to know
 * the lists (what every page of the web application runs before anybody has
 * signed in) takes them from `@diet-app/shared/options`, and loads no schema
 * and no validation library with them.
 */

/** The languages of the application. `en` is the one the catalogue is written in. */
export const LOCALES = ['en', 'pl'] as const;

/** The colour palettes, each with its blocks in the web application's `globals.css`. */
export const PALETTES = ['default', 'ocean', 'forest', 'sunset', 'mono', 'rose'] as const;
