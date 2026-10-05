// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// `npm audit` with a documented, expiring allowlist.
//
// npm audit has no native ignore mechanism: it is all-or-nothing at a severity
// threshold. That leaves only bad options when an advisory has no installable
// fix — drop the threshold for every package, or drop the gate entirely. This
// wrapper keeps the gate at full strength and subtracts exactly the advisories
// listed in audit-allowlist.json, each with a justification and an expiry.
//
// Usage:  node audit-check.mjs --dir <workspace> --audit-level <level> [--omit=dev]
// Exit:   0 when nothing at or above <level> remains after allowlisting.
//
// Failure modes that are deliberately hard errors:
//   - an expired allowlist entry (forces periodic re-review)
//   - a malformed allowlist (never fail open)
//   - npm audit itself not producing a report: no parseable JSON, or an error
//     in place of the results (no lockfile, registry unreachable)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALLOWLIST = path.join(__dirname, 'audit-allowlist.json');

const SEVERITY = ['info', 'low', 'moderate', 'high', 'critical'];

function parseArgs(argv) {
  const args = { dir: null, level: 'high', omitDev: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--audit-level') args.level = argv[++i];
    else if (a === '--omit=dev') args.omitDev = true;
    else {
      console.error(`audit-check: unknown argument "${a}"`);
      process.exit(2);
    }
  }
  if (!args.dir) {
    console.error('audit-check: --dir <workspace> is required');
    process.exit(2);
  }
  if (!SEVERITY.includes(args.level)) {
    console.error(`audit-check: invalid --audit-level "${args.level}"`);
    process.exit(2);
  }
  return args;
}

const { dir, level, omitDev } = parseArgs(process.argv.slice(2));
const threshold = SEVERITY.indexOf(level);
const scope = omitDev ? 'production' : 'all';
const label = `${dir} (${scope} deps, >= ${level})`;

// ── Load the allowlist ───────────────────────────────────────────────────────
// A broken allowlist must never silently disable suppression *or* the gate.
let allow;
try {
  const raw = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  if (!Array.isArray(raw.allow)) throw new Error('"allow" must be an array');
  allow = new Map();
  for (const e of raw.allow) {
    if (!e.ghsa || !e.expires || !e.reason || !Array.isArray(e.workspaces)) {
      throw new Error(
        `entry ${e.ghsa || '<missing ghsa>'} needs ghsa, reason, expires and workspaces`,
      );
    }
    if (Number.isNaN(Date.parse(e.expires))) {
      throw new Error(`entry ${e.ghsa} has an unparseable expires date "${e.expires}"`);
    }
    // Only entries justified for this workspace apply here.
    if (e.workspaces.includes(dir)) allow.set(e.ghsa, e);
  }
} catch (err) {
  console.error(`audit-check: cannot read ${ALLOWLIST}: ${err.message}`);
  process.exit(2);
}

// ── Run npm audit ────────────────────────────────────────────────────────────
// npm audit exits non-zero whenever it finds anything, so a thrown error is
// expected and the JSON still arrives on stdout.
const npmArgs = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])];
let stdout;
try {
  stdout = execFileSync('npm', npmArgs, {
    cwd: path.join(REPO_ROOT, dir),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  stdout = err.stdout;
}

let report;
try {
  report = JSON.parse(stdout);
} catch {
  console.error(`audit-check: npm audit produced no parseable JSON for ${dir}`);
  console.error((stdout || '').slice(0, 2000));
  process.exit(2);
}

// npm answers in JSON even when the audit could not run at all: an `error`
// object in place of the report (no lockfile, registry unreachable). That is
// not a clean audit — there is no result to read "no advisories" from.
if (report.error || !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
  const { code, summary, detail } = report.error || {};
  const why = [code, report.message, summary, detail].filter(Boolean).join(' — ');
  console.error(`audit-check: npm audit did not run for ${dir}${why ? `: ${why}` : ''}`);
  process.exit(2);
}

// ── Collect advisories ───────────────────────────────────────────────────────
// Deduplicate by GHSA: npm repeats the same advisory once per affected path.
const found = new Map();
for (const vuln of Object.values(report.vulnerabilities || {})) {
  for (const via of vuln.via || []) {
    if (typeof via !== 'object') continue; // a string means "via another package"
    const ghsa = (via.url || '').match(/GHSA-[0-9a-z-]+/i)?.[0];
    if (!ghsa) continue;
    if (!found.has(ghsa)) {
      found.set(ghsa, {
        ghsa,
        package: via.name || vuln.name,
        severity: via.severity || vuln.severity,
        title: via.title || '(no title)',
        url: via.url,
      });
    }
  }
}

// ── Classify ─────────────────────────────────────────────────────────────────
const now = Date.now();
const blocking = [];
const suppressed = [];
const expired = [];

for (const adv of found.values()) {
  // A severity this script does not know is held to the bar like any other:
  // skipping it would let the gate fail open.
  const level = SEVERITY.indexOf(adv.severity);
  if (level !== -1 && level < threshold) continue;
  const entry = allow.get(adv.ghsa);
  if (!entry) {
    blocking.push(adv);
  } else if (Date.parse(entry.expires) < now) {
    expired.push({ ...adv, expires: entry.expires });
  } else {
    suppressed.push({ ...adv, expires: entry.expires });
  }
}

// An allowlist entry that no longer matches anything is stale. Worth surfacing,
// but not worth failing a security gate over.
const stale = [...allow.keys()].filter((g) => !found.has(g));

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n── npm audit: ${label} ──`);

for (const a of suppressed) {
  console.log(`  ALLOWED   ${a.ghsa}  ${a.package}  [${a.severity}]  expires ${a.expires}`);
  console.log(`            ${a.title}`);
}
for (const g of stale) {
  console.log(`  STALE     ${g} is allowlisted but no longer reported — consider removing it`);
}
for (const a of expired) {
  console.log(`  EXPIRED   ${a.ghsa}  ${a.package}  [${a.severity}]  expired ${a.expires}`);
  console.log(`            ${a.title}`);
}
for (const a of blocking) {
  console.log(`  BLOCKING  ${a.ghsa}  ${a.package}  [${a.severity}]`);
  console.log(`            ${a.title}`);
  console.log(`            ${a.url}`);
}

if (expired.length) {
  console.error(
    `\naudit-check: ${expired.length} allowlist entry/entries expired for ${dir}.\n` +
      `Re-confirm the advisory is still unreachable and extend "expires", or fix it.`,
  );
  process.exit(1);
}

if (blocking.length) {
  console.error(`\naudit-check: ${blocking.length} unallowlisted advisory/advisories >= ${level} in ${label}.`);
  process.exit(1);
}

console.log(
  `  OK — no advisories >= ${level}` +
    (suppressed.length ? ` (${suppressed.length} allowlisted)` : ''),
);
