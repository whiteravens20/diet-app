/**
 * Upstream-PR ship runner — maintainer-only path that lands approved drafts
 * in the canonical repo via a gh-CLI pull request.
 *
 * STRICT RULES:
 *   - Off by default (`SHIP_UPSTREAM_ENABLED=false`).
 *   - The UI hides this mode unless the env flag is on AND `gh` is on PATH
 *     AND a token is configured. The controller refuses to dispatch the run
 *     when any precondition is missing — fail-closed, no silent surprises.
 *   - Self-hoster instances should NEVER flip the env flag on. The
 *     canonical baseline lives under maintainer review; an open public
 *     instance pushing PRs upstream is a vandalism vector.
 *
 * Per plan §E:
 *   1. Find the repo root (walk up from `process.cwd()` until `.git`).
 *   2. Check out `drafts/<kind>/<short-batch-id>` from
 *      `SHIP_UPSTREAM_BASE_BRANCH`.
 *   3. Run writers (`recipe-batches.writer.ts` for recipes, the merge writer
 *      for ingredient overrides).
 *   4. `git add` specific paths only — never `-A`.
 *   5. `git commit` honouring hooks (no `--no-verify`).
 *   6. `git push -u <remote> <branch>`.
 *   7. `gh pr create --title --body --base <base>`.
 *   8. Only on success: flip drafts to SHIPPED + shippedPRUrl.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import {
  ingredientOverridesPath,
  mergeIngredientOverrides,
  IngredientOverrideEntry,
  type IngredientOverrideFile,
} from './ingredient-overrides.writer.js';
import {
  recipeBatchFilePath,
  writeRecipeBatch,
  type ShippedRecipe,
} from './recipe-batches.writer.js';

export interface UpstreamShipConfig {
  enabled: boolean;
  remote: string;
  baseBranch: string;
  ghToken: string | null;
  authorName: string | null;
  authorEmail: string | null;
}

/** Patterns matched against `git remote get-url <remote>` to detect a
 *  configured remote that points at the canonical diet-app repo. Covers
 *  both https and ssh remote URL shapes. */
const CANONICAL_REMOTE_PATTERNS: RegExp[] = [
  /(^|[/:])whiteravens20\/diet-app(\.git)?$/i,
];

/** True iff `url` resolves to the canonical diet-app repo. */
export function isCanonicalRemoteUrl(url: string): boolean {
  return CANONICAL_REMOTE_PATTERNS.some((p) => p.test(url.trim()));
}

/** Resolve the URL `git remote get-url <remote>` returns. Null when git is
 *  unavailable, the repo isn't a working tree, or the remote is unknown. */
export function resolveRemoteUrl(repoRoot: string, remote: string): string | null {
  const r = spawnSync('git', ['remote', 'get-url', remote], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const url = (r.stdout || '').trim();
  return url.length > 0 ? url : null;
}

export interface UpstreamShipRequest {
  kind: 'recipe' | 'ingredient-name';
  batchIds?: string[];
  /** Absolute path to the data dir inside the canonical repo. */
  dataDir: string;
  /** Resolved repo root (the writer doubles back to ensure this is a git
   *  working tree). */
  repoRoot: string;
  config: UpstreamShipConfig;
}

export interface UpstreamShipResult {
  prUrl: string;
  branch: string;
  shippedDraftIds: string[];
  skipped: { draftId: string; reason: string }[];
}

export class UpstreamShipError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** True iff the gh CLI binary resolves on PATH. Used by the controller's
 *  /config endpoint so the UI can hide the option when gh isn't installed. */
export function ghAvailable(): boolean {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

/** True iff every precondition for upstream-pr mode is satisfied. The
 *  controller surfaces this in the /config endpoint. */
export function upstreamReady(config: UpstreamShipConfig): boolean {
  if (!config.enabled) return false;
  if (!config.ghToken) return false;
  return ghAvailable();
}

/** Returns a precondition error code if the runtime + repo state would
 *  refuse the ship; null when everything is good. Used by the /config
 *  endpoint so the admin UI can disable the button with a clear reason. */
export function upstreamBlockedReason(
  config: UpstreamShipConfig,
  repoRoot: string | null,
): string | null {
  if (!config.enabled) return 'SHIP_UPSTREAM_DISABLED';
  if (!config.ghToken) return 'SHIP_UPSTREAM_NO_TOKEN';
  if (!ghAvailable()) return 'GH_MODE_UNAVAILABLE';
  if (!repoRoot) return 'SHIP_REPO_ROOT_NOT_FOUND';
  const url = resolveRemoteUrl(repoRoot, config.remote);
  if (url && isCanonicalRemoteUrl(url)) {
    return 'SHIP_UPSTREAM_BLOCKED_CANONICAL';
  }
  return null;
}

/** Walk up from `start` until `.git` directory is found. Returns null if
 *  the repo root can't be located within 8 levels. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function shipRecipesUpstream(
  prisma: PrismaService,
  request: UpstreamShipRequest & { kind: 'recipe' },
): Promise<UpstreamShipResult> {
  guardPreconditions(request.config, request.repoRoot);
  const where = {
    status: 'APPROVED' as const,
    ...(request.batchIds && request.batchIds.length > 0
      ? { batchId: { in: request.batchIds } }
      : {}),
  };
  const drafts = await prisma.recipeDraft.findMany({ where, orderBy: { createdAt: 'asc' } });
  if (drafts.length === 0) {
    throw new UpstreamShipError('NO_APPROVED_DRAFTS', 'no approved recipe drafts to ship');
  }

  const skipped: { draftId: string; reason: string }[] = [];
  const rows: ShippedRecipe[] = [];
  for (const d of drafts) {
    const titles = (d.titles ?? {}) as Record<string, string>;
    const descriptions = (d.descriptions ?? {}) as Record<string, string>;
    const stepsByLocale = (d.steps ?? {}) as Record<string, string[]>;
    const ingredients = (d.ingredientsJson ?? []) as ShippedRecipe['ingredients'];
    rows.push({
      slug: d.slug,
      title: titles,
      description: descriptions,
      servings: d.servings,
      mealTypes: d.mealTypes as ShippedRecipe['mealTypes'],
      dietTags: d.dietTags as ShippedRecipe['dietTags'],
      prepMinutes: d.prepMinutes,
      cookMinutes: d.cookMinutes,
      difficulty: d.difficulty,
      ingredients,
      steps: stepsByLocale,
    });
  }

  const shortBatch = drafts[0].batchId.slice(0, 14);
  const branch = `drafts/recipes/${shortBatch}-${Date.now().toString(36)}`;

  await prepareBranch(request.repoRoot, request.config, branch);
  const filePath = writeRecipeBatch(request.dataDir, branch.replace(/[/]/g, '-'), rows).path;
  const commitMsg = `drafts: recipes batch ${shortBatch} (${rows.length} rows)`;
  await commitAndPush(request.repoRoot, request.config, branch, [filePath], commitMsg);

  const prUrl = await createPullRequest(request.repoRoot, request.config, branch, {
    title: commitMsg,
    body: buildRecipePrBody(drafts, rows.length),
  });

  await prisma.recipeDraft.updateMany({
    where: { id: { in: drafts.map((d) => d.id) } },
    data: { status: 'SHIPPED', shippedAt: new Date(), shippedPRUrl: prUrl },
  });

  return { prUrl, branch, shippedDraftIds: drafts.map((d) => d.id), skipped };
}

export async function shipIngredientNamesUpstream(
  prisma: PrismaService,
  request: UpstreamShipRequest & { kind: 'ingredient-name' },
): Promise<UpstreamShipResult> {
  guardPreconditions(request.config, request.repoRoot);
  const where = {
    status: 'APPROVED' as const,
    ...(request.batchIds && request.batchIds.length > 0
      ? { batchId: { in: request.batchIds } }
      : {}),
  };
  const drafts = await prisma.ingredientNameDraft.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });
  if (drafts.length === 0) {
    throw new UpstreamShipError(
      'NO_APPROVED_DRAFTS',
      'no approved ingredient-name drafts to ship',
    );
  }

  const skipped: { draftId: string; reason: string }[] = [];
  const additions: IngredientOverrideFile = {};
  for (const d of drafts) {
    const parsed = IngredientOverrideEntry.safeParse(d.suggestions);
    if (!parsed.success) {
      skipped.push({ draftId: d.id, reason: 'suggestions-shape-invalid' });
      continue;
    }
    additions[d.ingredientSlug] = parsed.data;
  }
  if (Object.keys(additions).length === 0) {
    throw new UpstreamShipError(
      'NO_VALID_DRAFTS',
      'every approved ingredient-name draft failed shape validation',
    );
  }

  const shortBatch = drafts[0].batchId.slice(0, 14);
  const branch = `drafts/ingredient-names/${shortBatch}-${Date.now().toString(36)}`;

  await prepareBranch(request.repoRoot, request.config, branch);
  const path = ingredientOverridesPath(request.dataDir);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  mergeIngredientOverrides(path, additions);
  const commitMsg = `drafts: ingredient-names batch ${shortBatch} (${Object.keys(additions).length} rows)`;
  await commitAndPush(request.repoRoot, request.config, branch, [path], commitMsg);

  const prUrl = await createPullRequest(request.repoRoot, request.config, branch, {
    title: commitMsg,
    body: buildIngredientPrBody(drafts, Object.keys(additions).length),
  });

  await prisma.ingredientNameDraft.updateMany({
    where: { id: { in: drafts.filter((d) => additions[d.ingredientSlug]).map((d) => d.id) } },
    data: { status: 'SHIPPED', shippedAt: new Date(), shippedPRUrl: prUrl },
  });

  return {
    prUrl,
    branch,
    shippedDraftIds: drafts.filter((d) => additions[d.ingredientSlug]).map((d) => d.id),
    skipped,
  };
}

// ── git plumbing ────────────────────────────────────────────────────────────

function guardPreconditions(config: UpstreamShipConfig, repoRoot: string): void {
  if (!config.enabled) {
    throw new UpstreamShipError(
      'SHIP_UPSTREAM_DISABLED',
      'SHIP_UPSTREAM_ENABLED is false — upstream-PR mode is off',
    );
  }
  if (!config.ghToken) {
    throw new UpstreamShipError(
      'SHIP_UPSTREAM_NO_TOKEN',
      'SHIP_UPSTREAM_GH_TOKEN is missing',
    );
  }
  if (!ghAvailable()) {
    throw new UpstreamShipError(
      'GH_MODE_UNAVAILABLE',
      '`gh` CLI not found on PATH',
    );
  }
  const url = resolveRemoteUrl(repoRoot, config.remote);
  if (url && isCanonicalRemoteUrl(url)) {
    throw new UpstreamShipError(
      'SHIP_UPSTREAM_BLOCKED_CANONICAL',
      `remote "${config.remote}" resolves to the canonical diet-app repo (${url}). ` +
        'AI-drafted content never pushes to the canonical baseline — even from ' +
        'the maintainer instance. Point SHIP_UPSTREAM_REMOTE at a private ' +
        'mirror, or use the local / bundle ship modes.',
    );
  }
}

async function prepareBranch(
  repoRoot: string,
  config: UpstreamShipConfig,
  branch: string,
): Promise<void> {
  run(repoRoot, ['fetch', config.remote, config.baseBranch]);
  run(repoRoot, ['checkout', '-B', branch, `${config.remote}/${config.baseBranch}`]);
}

async function commitAndPush(
  repoRoot: string,
  config: UpstreamShipConfig,
  branch: string,
  paths: string[],
  commitMessage: string,
): Promise<void> {
  for (const p of paths) {
    run(repoRoot, ['add', '--', p]);
  }
  const commitEnv: NodeJS.ProcessEnv = {};
  if (config.authorName) commitEnv.GIT_AUTHOR_NAME = config.authorName;
  if (config.authorEmail) commitEnv.GIT_AUTHOR_EMAIL = config.authorEmail;
  if (config.authorName) commitEnv.GIT_COMMITTER_NAME = config.authorName;
  if (config.authorEmail) commitEnv.GIT_COMMITTER_EMAIL = config.authorEmail;
  run(repoRoot, ['commit', '-m', commitMessage], { env: { ...process.env, ...commitEnv } });
  run(repoRoot, ['push', '-u', config.remote, branch]);
}

async function createPullRequest(
  repoRoot: string,
  config: UpstreamShipConfig,
  branch: string,
  pr: { title: string; body: string },
): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.ghToken) env.GH_TOKEN = config.ghToken;
  const result = spawnSync(
    'gh',
    ['pr', 'create', '--title', pr.title, '--body', pr.body, '--base', config.baseBranch, '--head', branch],
    { cwd: repoRoot, env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new UpstreamShipError(
      'GH_PR_CREATE_FAILED',
      `gh pr create failed: ${result.stderr || result.stdout}`,
    );
  }
  const url = (result.stdout || '').trim().split('\n').pop() ?? '';
  if (!/^https?:\/\//.test(url)) {
    throw new UpstreamShipError(
      'GH_PR_CREATE_FAILED',
      `unexpected gh output: ${result.stdout}`,
    );
  }
  return url;
}

function run(cwd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new UpstreamShipError(
      'GIT_FAILED',
      `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`,
    );
  }
}

function buildRecipePrBody(
  drafts: Array<{ id: string; slug: string; batchId: string; modelUsed: string | null }>,
  rowCount: number,
): string {
  const lines = drafts.map((d) => `- ${d.slug} (\`${d.id.slice(0, 8)}\`)`);
  const model = drafts[0]?.modelUsed ?? 'unknown';
  return [
    `Curation queue shipped ${rowCount} recipe draft(s) generated by \`${model}\`.`,
    '',
    `Batch: \`${drafts[0]?.batchId ?? '-'}\``,
    '',
    'Approved drafts:',
    ...lines,
    '',
    'Reviewed in-app at /admin/curation before this PR was opened.',
  ].join('\n');
}

function buildIngredientPrBody(
  drafts: Array<{ id: string; ingredientSlug: string; batchId: string; modelUsed: string | null }>,
  rowCount: number,
): string {
  const lines = drafts.map((d) => `- ${d.ingredientSlug}`);
  const model = drafts[0]?.modelUsed ?? 'unknown';
  return [
    `Curation queue shipped ${rowCount} ingredient-name override(s) drafted by \`${model}\`.`,
    '',
    `Batch: \`${drafts[0]?.batchId ?? '-'}\``,
    '',
    'Overrides:',
    ...lines,
    '',
    'Reviewed in-app at /admin/curation before this PR was opened.',
  ].join('\n');
}

// Re-export for the controller success payload.
export { recipeBatchFilePath };
