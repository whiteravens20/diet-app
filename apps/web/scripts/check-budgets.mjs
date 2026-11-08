// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// The JavaScript a first visit of each page needs, as `next build` left it: the scripts its HTML names (the
// framework's own and those of the page's segments), compressed as a server sends them, held to the budgets of
// `budgets.json`, as soon as the build is there. The browser tests hold the running application to the same
// budgets (`e2e/weight.spec.ts`), and count the same scripts. A script for browsers without modules is one no
// current browser fetches, and counts for nothing. Run after the build: `npm run budgets`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const next = join(web, '.next');
const budgets = JSON.parse(readFileSync(join(web, 'budgets.json'), 'utf8'));
const pages = { ...budgets.open, ...budgets.account, ...budgets.contract };
if (!existsSync(join(next, 'build-manifest.json'))) {
  console.error(`No build in ${next}: run \`npm run build\` first.`);
  process.exit(1);
}
const build = JSON.parse(readFileSync(join(next, 'build-manifest.json'), 'utf8'));

/** The manifest of a page's client references, found by its path; groups such as `(app)` are not in the path. */
function manifestOf(path) {
  const walk = (folder, rest) => {
    const here = join(folder, 'page_client-reference-manifest.js');
    if (rest.length === 0 && existsSync(here)) return here;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const group = /^\(.*\)$/.test(entry.name);
      if (!group && entry.name !== rest[0]) continue;
      const found = walk(join(folder, entry.name), group ? rest : rest.slice(1));
      if (found) return found;
    }
    return null;
  };
  return walk(join(next, 'server', 'app'), path.split('/').filter(Boolean));
}

/** The scripts the HTML of a page names: the framework's, and those of every segment of the page. */
function scriptsOf(path) {
  const file = manifestOf(path);
  if (!file) return [];
  const context = {};
  vm.runInNewContext(readFileSync(file, 'utf8'), context);
  const manifest = Object.values(context.__RSC_MANIFEST ?? {})[0];
  return [
    ...new Set([...build.rootMainFiles, ...Object.values(manifest?.entryJSFiles ?? {}).flat()]),
  ];
}

const sizes = new Map();
const kB = (scripts) =>
  Math.round(
    scripts.reduce((bytes, script) => {
      if (!sizes.has(script)) sizes.set(script, gzipSync(readFileSync(join(next, script))).length);
      return bytes + sizes.get(script);
    }, 0) / 100,
  ) / 10;

const weights = Object.keys(pages).map((path) => ({
  what: path,
  scripts: scriptsOf(path),
  budget: pages[path],
}));
const everywhere = weights
  .map((weight) => weight.scripts)
  .reduce((shared, scripts) => shared.filter((script) => scripts.includes(script)));
const lines = [
  ...weights,
  { what: 'shared by all', scripts: everywhere, budget: budgets.shared },
].map((line) => ({
  ...line,
  kB: kB(line.scripts),
}));
for (const line of lines)
  console.log(
    `${line.what.padEnd(18)} ${String(line.kB).padStart(6)} kB of ${line.budget}${line.kB > line.budget ? '  over' : ''}`,
  );

// The measurement measures: a page whose scripts were not found would weigh nothing, and pass.
const unfound = lines.filter((line) => line.scripts.length < 5).map((line) => line.what);
const over = lines
  .filter((line) => line.kB > line.budget)
  .map((line) => `${line.what}: ${line.kB} kB, budget ${line.budget}`);
if (unfound.length)
  console.error(`No scripts found for: ${unfound.join(', ')}. Was the application built?`);
if (over.length) console.error(`Over the budget: ${over.join('; ')}.`);
process.exit(unfound.length || over.length ? 1 : 0);
