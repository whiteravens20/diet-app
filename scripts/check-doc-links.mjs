#!/usr/bin/env node
/**
 * Relative-link checker for Markdown. Walks every tracked `*.md` file, extracts
 * relative links (and image sources), and fails if a target doesn't exist on
 * disk. External (http/https/mailto) links and pure `#anchor` links are skipped
 * — this guards against broken *intra-repo* links, which is what rots on rename.
 *
 * Run: `node scripts/check-doc-links.mjs`
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

// Tracked markdown only (skips node_modules, build output, untracked scratch).
const files = execSync('git ls-files "*.md"', { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const problems = [];

// Extract markdown link destinations, allowing balanced parentheses in the URL
// (Next route-group dirs like `(auth)` are valid in a destination).
function destinations(content) {
  const out = [];
  for (let i = 0; i < content.length; i++) {
    // A link destination opens with `](` — find it, then read to the matching `)`.
    if (content[i] !== ']' || content[i + 1] !== '(') continue;
    let depth = 1;
    let j = i + 2;
    for (; j < content.length && depth > 0; j++) {
      if (content[j] === '(') depth++;
      else if (content[j] === ')') depth--;
    }
    if (depth === 0) out.push(content.slice(i + 2, j - 1));
    i = j - 1;
  }
  return out;
}

for (const rel of files) {
  const abs = join(repoRoot, rel);
  const content = readFileSync(abs, 'utf8');
  for (const raw of destinations(content)) {
    let target = raw.trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+/)[0]; // strip a `"title"`
    if (!target || /^(https?:|mailto:|tel:|#)/i.test(target)) continue;
    const path = target.split('#')[0];
    if (!path) continue; // pure anchor
    const resolved = resolve(dirname(abs), path);
    if (!resolved.startsWith(repoRoot) || !existsSync(resolved)) {
      problems.push(`${rel} → ${raw}`);
    }
  }
}

if (problems.length) {
  console.error(`✖ ${problems.length} broken intra-repo doc link(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ doc links OK (${files.length} markdown files scanned)`);
