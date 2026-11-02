// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How often a code the instance does not know may be asked of Open Food
 * Facts: by an account in a minute and in a day, and by the whole instance in
 * a minute, which stays under the 15 a minute Open Food Facts allows one
 * address.
 */
export const PRODUCT_LOOKUPS = { accountMinute: 5, accountDay: 100, instanceMinute: 12 } as const;

/**
 * How long, in days, the instance goes by what Open Food Facts answered to one
 * code: that it does not know it, and what it said of a product no import
 * brings.
 */
export const PRODUCT_MEMORY_DAYS = { unknown: 7, lookedUp: 30 } as const;

/**
 * How many days a product no import brings stays once nobody has asked for it:
 * at twelve lookups a minute the table cannot grow past this many days of them,
 * whoever asks. The next who scans it has it read again.
 */
export const LOOKED_UP_KEPT_DAYS = 90;

/** How long a name, a brand and a pack's words may be when they are kept. */
export const PRODUCT_TEXT_LIMITS = { name: 160, brand: 80, pack: 40 } as const;
