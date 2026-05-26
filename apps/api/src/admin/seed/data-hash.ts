/**
 * Snapshot of the on-disk seed-data files.
 *
 * The hash is sha256 over the byte contents of every file in `SEED_FILES`, in
 * deterministic order, with each file's name prefixed and a marker substituted
 * when a file is absent. Same files → same hash → the admin panel can flag
 * "update available" by comparing this against `SeedMeta.hash` from the last
 * successful run.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SEED_FILES = [
  'ingredients.json',
  'ingredients.generated.json',
  'recipes.json',
  'substitutions.json',
] as const;

export interface SeedFileSnapshot {
  name: (typeof SEED_FILES)[number];
  present: boolean;
  bytes: number;
}

export interface DataState {
  hash: string;
  files: SeedFileSnapshot[];
}

/**
 * Resolve the curated `data/` directory. Layouts we support:
 *
 *   - dev (cwd = repo root or `apps/api`): `data/` sits at the repo root.
 *   - container (cwd = `/app`): the Dockerfile copies `data` to `/app/data`.
 *   - CLI run from `apps/api`: cwd two levels up.
 *
 * Override via `SEED_DATA_DIR` for tests / non-standard layouts.
 */
export function resolveDataDir(): string {
  if (process.env.SEED_DATA_DIR) return resolve(process.env.SEED_DATA_DIR);
  const candidates = [
    resolve(process.cwd(), 'data'),
    resolve(process.cwd(), '../../data'),
    resolve(process.cwd(), '../../../data'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

export function computeDataState(dir = resolveDataDir()): DataState {
  const hash = createHash('sha256');
  const files: SeedFileSnapshot[] = [];
  for (const name of SEED_FILES) {
    const path = join(dir, name);
    if (existsSync(path)) {
      const buf = readFileSync(path);
      hash.update(`${name}:`);
      hash.update(buf);
      files.push({ name, present: true, bytes: buf.length });
    } else {
      hash.update(`${name}:missing`);
      files.push({ name, present: false, bytes: 0 });
    }
  }
  return { hash: hash.digest('hex'), files };
}
