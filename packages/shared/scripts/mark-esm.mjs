// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// The package's files are CommonJS unless a package.json nearer to them says
// otherwise. This says so for the build a bundler reads (dist/esm), so that
// Node takes those files for the ES modules they are.
//
// A bundler reads from that same package.json which files do something by
// being loaded, and keeps every file of a package that does not say. Here it
// is one file, the one that sets the validation library up; every other file
// only defines what it exports, so a page gets the files it uses and no more.
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/esm/package.json', import.meta.url),
  `${JSON.stringify({ type: 'module', sideEffects: ['./zod.js'] })}\n`,
);
