// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const E2E = path.resolve(process.cwd(), 'e2e');

describe('a browser test', () => {
  // The fixtures give the shared session back after every test, its answers, media and size; a script
  // put before every page of it would stay for the tests after.
  it('puts no script before the pages it opens', () => {
    const scripted = readdirSync(E2E).filter(
      (file) =>
        file.endsWith('.spec.ts') &&
        readFileSync(path.join(E2E, file), 'utf8').includes('addInitScript('),
    );

    expect(scripted).toEqual([]);
  });
});
