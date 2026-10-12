// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { config } from 'zod';

/**
 * The validation library, as every schema of the contract takes it: set up
 * for where it runs before a schema is made, because the library decides how
 * a schema checks when the schema is made.
 *
 * A server lets it compile a check into code of its own, which is faster. A
 * page in a browser does not: its content security policy forbids code made
 * at run time, and the library's try at it is reported as a violation of the
 * policy on every page, although the library would then go on without.
 */
if ('document' in globalThis) config({ jitless: true });

export * from 'zod';
