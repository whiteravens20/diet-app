// Quarantine check for a Dependabot PR.
//
// Reads the *target* versions Dependabot wants to introduce from the PR title
// ("bump <pkg> from <a> to <b>") and the grouped-update body table
// ("| <pkg> | `<from>` | `<to>` |"), then checks each against the
// min-release-age policy. This deliberately uses the PR's declared targets
// rather than the package.json diff, because indirect/transitive bumps (e.g.
// undici) only ever touch package-lock.json and would otherwise be invisible.
// It is also path-agnostic — the diet-app workspace manifests live under
// apps/* and packages/*, so a diff-path filter would silently match nothing.
//
// Usage:  node check-quarantine.mjs <pr-number>
// Env:    QUARANTINE_DAYS (default 7), GH_TOKEN/GITHUB_TOKEN for gh.
// Output: a single JSON line {"blocked":bool,"details":string} on stdout;
//         a human-readable log on stderr.

import { execFileSync } from 'node:child_process';

const prNumber = process.argv[2];
if (!prNumber) {
  console.error('usage: check-quarantine.mjs <pr-number>');
  process.exit(2);
}
const QUARANTINE_DAYS = parseInt(process.env.QUARANTINE_DAYS || '7', 10);

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

const { title, body } = JSON.parse(
  gh(['pr', 'view', prNumber, '--json', 'title,body']),
);

// Collect { name -> targetVersion }. Later sources win, which is fine since
// the body table is authoritative for grouped updates.
const deps = new Map();

const titleMatch = title.match(/bump\s+(\S+)\s+from\s+\S+\s+to\s+(\S+)/i);
if (titleMatch) deps.set(titleMatch[1], titleMatch[2]);

for (const line of (body || '').split('\n')) {
  // | [name](url) | `from` | `to` |   (name may be a bare or linked package)
  const m = line.match(
    /^\|\s*\[?([^\]|]+?)\]?(?:\([^)]*\))?\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/,
  );
  if (m) deps.set(m[1].trim(), m[3].trim());
}

const now = Date.now();
const blocked = [];

for (const [pkg, version] of deps) {
  let published = '';
  try {
    const time = JSON.parse(
      execFileSync('npm', ['view', `${pkg}@${version}`, 'time', '--json'], {
        encoding: 'utf8',
        // min-release-age in .npmrc can make `npm view` refuse a too-new exact
        // version; ignore it here so we read the real publish date ourselves.
        env: { ...process.env, npm_config_min_release_age: '' },
      }),
    );
    published = time[version] || '';
  } catch {
    // fall through: unknown publish date is treated as blocked below
  }

  if (!published) {
    console.error(`⚠️  ${pkg}@${version} — publish date unknown, treating as blocked`);
    blocked.push(`- \`${pkg}@${version}\` — publish date unknown`);
    continue;
  }

  const ageDays = Math.floor((now - new Date(published).getTime()) / 86_400_000);
  if (ageDays < QUARANTINE_DAYS) {
    console.error(`🔒 ${pkg}@${version} — ${ageDays}d old (needs ${QUARANTINE_DAYS}d)`);
    blocked.push(`- \`${pkg}@${version}\` — ${ageDays}d old (needs ${QUARANTINE_DAYS}d)`);
  } else {
    console.error(`✅ ${pkg}@${version} — ${ageDays}d old (OK)`);
  }
}

process.stdout.write(
  JSON.stringify({ blocked: blocked.length > 0, details: blocked.join('\n') }),
);
