// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// The package's files are CommonJS unless a package.json nearer to them says
// otherwise. This says so for the build a bundler reads (dist/esm), so that
// Node takes those files for the ES modules they are.
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/esm/package.json', import.meta.url), `${JSON.stringify({ type: 'module' })}\n`);
