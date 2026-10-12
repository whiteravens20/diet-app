// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { config } from 'zod';

/**
 * How the schemas check their input. A server lets the library compile a
 * check into code of its own, which is faster. A page in a browser does not:
 * its content security policy forbids code made at run time, and the
 * library's try at it is reported as a violation of the policy on every page,
 * although the library would then go on without.
 *
 * This runs before any schema is made (the entry point imports it first):
 * the library decides how a schema checks when the schema is made.
 */
if ('document' in globalThis) config({ jitless: true });
