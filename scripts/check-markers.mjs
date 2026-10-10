#!/usr/bin/env node
// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Keeps planning labels and dangling references out of the repository.
 *
 * A comment, a test name or a document says what the code does. It does not
 * carry an identifier that only a planning document explains (a feature number,
 * a phase name, a work-item id), an unfinished-work note, or a pointer to a
 * document the repository ignores: a reader of the public tree cannot resolve
 * any of them.
 *
 * Applied migrations are history and are not checked: their content is fixed
 * once an instance has run them.
 *
 * Run: `node scripts/check-markers.mjs`
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Text files worth reading; everything else (images, fonts, lockfiles) is skipped. */
const TEXT_FILE = /(\.(c|m)?js|\.tsx?|\.json|\.md|\.ya?ml|\.prisma|\.css|\.sh|\.toml|\.example|\.conf|(^|\/)Dockerfile|(^|\/)\.[a-z]+rc|(^|\/)\.gitignore|(^|\/)\.husky\/[a-z-]+)$/;

const SKIPPED = [
  /^package-lock\.json$/,
  /^apps\/api\/prisma\/migrations\//,
  // This checker and its examples name the things they look for.
  /^scripts\/check-markers(\.test)?\.mjs$/,
];

/** Shipped source: stricter rules apply than to prose and configuration. */
const SOURCE = /^(apps|packages)\/[^/]+\/src\/.*\.tsx?$/;
const TEST = /\.test\.tsx?$/;

const RULES = [
  { name: 'feature number', pattern: /(?<![\w-])F\d{1,3}(?:\.\d+)?(?:\([a-z]\))?(?!\w)/ },
  { name: 'phase label', pattern: /\b(?:Phase|Faza)[ -][A-Z0-9]{1,2}\b/ },
  { name: 'work-item id', pattern: /\b(?:WI|WP)-[A-Z]?\d+\b/ },
  {
    name: 'reference to a planning document',
    pattern: /\bprinciple #\d+|\bplan [A-Z]\d+\b|§\s?\d+ invariant|\bper §\s?\d+/,
    only: (file) => SOURCE.test(file),
  },
  { name: 'phase label', pattern: /\bphase [a-z0-9]/i, only: (file) => SOURCE.test(file) && !TEST.test(file) },
  { name: 'unfinished-work note', pattern: /\bTODO\b|\bFIXME\b|coming soon/i, only: (file) => SOURCE.test(file) && !TEST.test(file) },
];

/** A decision-record reference, flagged while the records are not in the repository. */
const DECISION_RECORD = /\bADR[- ]?\d{1,4}\b/;
/** A path under docs/, checked against the documents the repository ignores. */
const DOCS_PATH = /\bdocs\/[A-Za-z0-9_][A-Za-z0-9_./-]*/g;

/** The documents `.gitignore` keeps out of the repository: its `/docs/…` entries. */
export function ignoredDocs(gitignore) {
  return gitignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/docs/'))
    .map((line) => line.slice(1).replace(/\/$/, ''));
}

/**
 * Every problem in one file's text.
 * `ignored` lists the ignored documents (see `ignoredDocs`); `recordsPublished`
 * says whether the decision records are part of the repository.
 */
export function findMarkers(file, text, { ignored, recordsPublished }) {
  const problems = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const report = (rule) => problems.push({ file, line: index + 1, rule, text: line.trim() });
    for (const rule of RULES) {
      if (rule.only && !rule.only(file)) continue;
      if (rule.pattern.test(line)) report(rule.name);
    }
    if (!recordsPublished && DECISION_RECORD.test(line)) report('decision record that is not in the repository');
    // `.gitignore` is where the ignored documents are named.
    if (file === '.gitignore') return;
    for (const [path] of line.matchAll(DOCS_PATH)) {
      const clean = path.replace(/[.,;:)\]/]+$/, '');
      if (ignored.some((doc) => clean === doc || clean.startsWith(`${doc}/`))) {
        report(`document that is not in the repository (${clean})`);
      }
    }
  });
  return problems;
}

function main() {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const ignored = ignoredDocs(readFileSync(join(root, '.gitignore'), 'utf8'));
  const recordsPublished = tracked.some((file) => file.startsWith('docs/adr/'));

  const problems = tracked
    .filter((file) => TEXT_FILE.test(file) && !SKIPPED.some((skip) => skip.test(file)))
    .flatMap((file) => findMarkers(file, readFileSync(join(root, file), 'utf8'), { ignored, recordsPublished }));

  if (problems.length === 0) {
    console.log('No planning labels or dangling references.');
    return;
  }
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.rule}: ${p.text.slice(0, 140)}`);
  console.error(`\n${problems.length} problem(s). Say what the code does instead of naming a plan item, and point only at documents in the repository.`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
