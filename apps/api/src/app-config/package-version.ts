// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The version in the repository's root `package.json`, which the image carries
 * at `/app/package.json`. Read once; `unknown` when the file is not where both
 * layouts put it.
 */
export const PACKAGE_VERSION: string = (() => {
  try {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../../../package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
