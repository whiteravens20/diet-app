// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// Run: `node --test scripts/check-markers.test.mjs`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMarkers, ignoredDocs } from './check-markers.mjs';

const ignored = ignoredDocs('node_modules/\n/docs/adr/\n/docs/ops/testing.md\n/instance-data/\n');
const check = (file, text, recordsPublished = false) =>
  findMarkers(file, text, { ignored, recordsPublished }).map((p) => p.rule);

test('reads the ignored documents out of .gitignore', () => {
  assert.deepEqual(ignored, ['docs/adr', 'docs/ops/testing.md']);
});

test('accepts a comment that says what the code does', () => {
  assert.deepEqual(check('apps/api/src/engine/optimizer.ts', '// Variety floor: total uses of a recipe across the window.'), []);
});

test('rejects feature numbers in comments, test names and prose', () => {
  for (const line of [
    '// F17 variety floor',
    "describe('rebalanceDay (F22 quantity rebalancer)', () => {",
    ' * F15.1 anti-monotony rotation.',
    '/** F22(b) add a custom meal. */',
    '## Admin (F16)',
    ' * F10-aware failover chain for a user.',
  ]) {
    assert.deepEqual(check('docs/ops/deployment.md', line), ['feature number'], line);
  }
});

test('does not mistake hex colours, key names or identifiers for feature numbers', () => {
  for (const line of ['color: #F3F4F6;', 'const KEY = "\\uF001";', 'export const F1_SCORE_LABEL = 1;', 'heading-F12-like']) {
    assert.deepEqual(check('apps/web/src/app/globals.css', line), [], line);
  }
});

test('rejects phase labels and work-item ids everywhere', () => {
  assert.deepEqual(check('.env.example', '# Ship mechanism (Phase E)'), ['phase label']);
  assert.deepEqual(check('apps/api/src/x.test.ts', '// Regression guard for the post-Phase-D live-test fix.'), ['phase label']);
  assert.deepEqual(check('apps/api/src/common/security.test.ts', "describe('headers (WI-F1)', () => {"), ['work-item id']);
  assert.deepEqual(check('README.md', 'Tracked as WP-07.'), ['work-item id']);
});

test('is stricter in shipped source than in tests and prose', () => {
  const line = '// TODO: handle the second phase of the import';
  assert.deepEqual(check('apps/api/src/admin/usda/importer.ts', line), ['phase label', 'unfinished-work note']);
  assert.deepEqual(check('apps/api/src/admin/usda/importer.test.ts', line), []);
  assert.deepEqual(check('CONTRIBUTING.md', line), []);
});

test('rejects references to planning documents in source', () => {
  for (const line of ['// never a hard dependency (product principle #8).', '// Matches plan D1.', '// §3 invariant — edits invalidate reviews.']) {
    assert.deepEqual(check('apps/api/src/ai/ai-router.service.ts', line), ['reference to a planning document'], line);
  }
});

test('rejects a pointer to an ignored document, and nothing else under docs/', () => {
  assert.deepEqual(check('apps/api/prisma/schema.prisma', '// see docs/adr/0008-curation-queue.md.'), [
    'document that is not in the repository (docs/adr/0008-curation-queue.md)',
  ]);
  assert.deepEqual(check('README.md', 'See docs/ops/testing.md and docs/ops/deployment.md.'), [
    'document that is not in the repository (docs/ops/testing.md)',
  ]);
  assert.deepEqual(check('CONTRIBUTING.md', 'Branch naming: `docs/short-description`.'), []);
  assert.deepEqual(check('apps/web/next-env.d.ts', '// see https://nextjs.org/docs/app/api-reference'), []);
});

test('lets .gitignore name the documents it ignores', () => {
  assert.deepEqual(check('.gitignore', '/docs/adr/'), []);
});

test('rejects decision-record numbers only while the records are unpublished', () => {
  const line = ' * the live table is never touched (see ADR-0008).';
  assert.deepEqual(check('apps/api/src/admin/drafts/runner.ts', line), ['decision record that is not in the repository']);
  assert.deepEqual(check('apps/api/src/admin/drafts/runner.ts', line, true), []);
});
