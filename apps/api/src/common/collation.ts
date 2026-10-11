// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Prisma } from '@prisma/client';
import type { Locale } from '@diet-app/shared';

/**
 * The order of the alphabet of each language the application speaks, as the
 * database knows it. A list of names is sorted by the names it shows: Polish
 * ones with `ą` after `a` and `ł` after `l`, and no list with every capital
 * before every small letter, which is what the order of the bytes gives.
 *
 * These collations come with a PostgreSQL that is built with ICU, as the
 * image the application ships with is.
 */
const COLLATIONS: Record<Locale, string> = { en: 'en-x-icu', pl: 'pl-x-icu' };

/** `COLLATE …` for a name shown in `locale`, for an `ORDER BY` of a raw query. */
export function collatedFor(locale: Locale): Prisma.Sql {
  return Prisma.raw(`COLLATE "${COLLATIONS[locale]}"`);
}

/** `text` as a pattern that matches it anywhere in a value, whatever signs of a pattern it holds itself. */
export function containing(text: string): string {
  return `%${text.replace(/[\\%_]/g, (sign) => `\\${sign}`)}%`;
}
