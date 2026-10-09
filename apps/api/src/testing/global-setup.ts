// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { prepareTestDatabase } from './database.js';

/** Runs once before the integration tests: the test database exists and is migrated. */
export default async function globalSetup(): Promise<void> {
  await prepareTestDatabase();
}
