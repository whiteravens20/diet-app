// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Shipping as a pull request: approved drafts are written into a checkout of
 * a repository, committed on a branch of their own, pushed, and offered as a
 * pull request through the `gh` tool.
 *
 * The mode is off unless `SHIP_UPSTREAM_ENABLED` is set, and it refuses when
 * no token is configured, when `gh` is missing, when no checkout is found, or
 * when the remote is this project's own repository: text a model wrote is
 * never pushed there. Each refusal has a code of its own, and the panel is
 * told the same code when it asks which modes are on offer.
 *
 * One run:
 *   1. check out `drafts/<kind>/<batch>-<stamp>` from the base branch of the remote,
 *   2. write the batch file, or merge the names into the override file,
 *   3. `git add` that one file, commit it (hooks run) and push the branch,
 *   4. `gh pr create` against the base branch,
 *   5. and only then mark the drafts shipped, with the pull request's address.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import {
  ingredientOverridesPath,
  mergeIngredientOverrides,
  type IngredientOverrideFile,
} from './ingredient-overrides.writer.js';
import { writeRecipeBatch, type ShippedRecipe } from './recipe-batches.writer.js';
import { buildCurrentIngredientOverrides } from './current-overrides.js';
import { sortRecipesForFile } from './library.js';
import { shippableIngredientName, sortForShipping, type Skipped } from './shippable.js';

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

/** True iff `url` resolves to the canonical diet-app repo. A trailing slash names the same repository. */
export function isCanonicalRemoteUrl(url: string): boolean {
  const address = url.trim().replace(/\/+$/, '');
  return CANONICAL_REMOTE_PATTERNS.some((p) => p.test(address));
}

/**
 * Runs `git` or `gh` and reports how it ended. Everything this mode does
 * outside the process goes through one of these, so that a test can hand in a
 * stand-in and no test starts either tool or reaches a remote.
 */
export type CommandRunner = (
  command: 'git' | 'gh',
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; stderr: string };

/** The runner outside tests: starts the tool and waits for it. */
const runCommand: CommandRunner = (command, args, options) => {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/** Resolve the URL `git remote get-url <remote>` returns. Null when git is
 *  unavailable, the repo isn't a working tree, or the remote is unknown. */
function resolveRemoteUrl(repoRoot: string, remote: string, run: CommandRunner = runCommand): string | null {
  const r = run('git', ['remote', 'get-url', remote], { cwd: repoRoot });
  if (r.status !== 0) return null;
  const url = r.stdout.trim();
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
  /** What runs `git` and `gh`; the real tools unless a test hands in a stand-in. */
  run?: CommandRunner;
}

export interface UpstreamShipResult {
  prUrl: string;
  branch: string;
  shippedDraftIds: string[];
  skipped: Skipped[];
}

/** Why a pull request cannot be opened from here at all: what the settings, the tool or the checkout say. */
export type UpstreamBlocked = 'SHIP_UPSTREAM_DISABLED' | 'SHIP_UPSTREAM_NO_TOKEN' | 'GH_MODE_UNAVAILABLE' | 'SHIP_REPO_ROOT_NOT_FOUND' | 'SHIP_UPSTREAM_BLOCKED_CANONICAL';

/** The codes a ship as a pull request is refused with. */
export type UpstreamShipCode = UpstreamBlocked | 'NO_APPROVED_DRAFTS' | 'NO_VALID_DRAFTS' | 'NO_CURRENT_OVERRIDES' | 'GIT_FAILED' | 'GH_PR_CREATE_FAILED';

export class UpstreamShipError extends Error {
  constructor(
    public readonly code: UpstreamShipCode,
    message: string,
    /** What a client is told besides the code: the drafts that were held back, when none could ship. */
    public readonly details?: { skipped: Skipped[] },
  ) {
    super(message);
  }
}

/** True iff the gh CLI binary resolves on PATH. Used by the controller's
 *  /config endpoint so the UI can hide the option when gh isn't installed. */
function ghAvailable(run: CommandRunner = runCommand): boolean {
  return run('gh', ['--version'], {}).status === 0;
}

/** Returns a precondition error code if the runtime + repo state would
 *  refuse the ship; null when everything is good. Used by the /config
 *  endpoint so the admin UI can disable the button with a clear reason. */
export function upstreamBlockedReason(
  config: UpstreamShipConfig,
  repoRoot: string | null,
  run: CommandRunner = runCommand,
): UpstreamBlocked | null {
  // What the settings alone decide comes first: a mode that is switched off
  // says so without looking for a tool or a repository.
  if (!config.enabled) return 'SHIP_UPSTREAM_DISABLED';
  if (!config.ghToken) return 'SHIP_UPSTREAM_NO_TOKEN';
  if (!ghAvailable(run)) return 'GH_MODE_UNAVAILABLE';
  if (!repoRoot) return 'SHIP_REPO_ROOT_NOT_FOUND';
  const url = resolveRemoteUrl(repoRoot, config.remote, run);
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
  const run = request.run ?? runCommand;
  guardPreconditions(request.config, request.repoRoot, run);
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

  // Held to the terms of a recipe that ships into this instance; what does not pass stays in the queue.
  const { shipping, skipped } = await sortRecipesForFile(prisma, drafts);
  if (shipping.length === 0) {
    throw new UpstreamShipError('NO_VALID_DRAFTS', 'None of the approved recipe drafts can ship as they are.', { skipped });
  }
  const rows: ShippedRecipe[] = shipping.map((entry) => entry.content);

  const shortBatch = drafts[0].batchId.slice(0, 14);
  const branch = `drafts/recipes/${shortBatch}-${Date.now().toString(36)}`;

  await prepareBranch(request.repoRoot, request.config, branch, run);
  const filePath = writeRecipeBatch(request.dataDir, branch.replace(/[/]/g, '-'), rows).path;
  const commitMsg = `drafts: recipes batch ${shortBatch} (${rows.length} rows)`;
  await commitAndPush(request.repoRoot, request.config, branch, [filePath], commitMsg, run);

  const prUrl = await createPullRequest(request.repoRoot, request.config, branch, { title: commitMsg, body: buildRecipePrBody(drafts, rows.length) }, run);

  const marked = await markPushed(
    shipping.map((entry) => entry.draft),
    (draft) => draft.slug,
    (where, data) => prisma.recipeDraft.updateMany({ where, data }),
    prUrl,
  );
  return { prUrl, branch, shippedDraftIds: marked.shipped, skipped: [...skipped, ...marked.changed] };
}

export async function shipIngredientNamesUpstream(
  prisma: PrismaService,
  request: UpstreamShipRequest & { kind: 'ingredient-name' },
): Promise<UpstreamShipResult> {
  const run = request.run ?? runCommand;
  guardPreconditions(request.config, request.repoRoot, run);
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

  // Only the names of a draft's own languages ship, and only plain ones.
  const { shipping, skipped } = sortForShipping(drafts, shippableIngredientName, (draft) => draft.ingredientSlug);
  if (shipping.length === 0) {
    throw new UpstreamShipError('NO_VALID_DRAFTS', 'None of the approved ingredient-name drafts can ship as they are.', { skipped });
  }
  const additions: IngredientOverrideFile = {};
  for (const entry of shipping) additions[entry.draft.ingredientSlug] = entry.content;

  const shortBatch = drafts[0].batchId.slice(0, 14);
  const branch = `drafts/ingredient-names/${shortBatch}-${Date.now().toString(36)}`;

  await prepareBranch(request.repoRoot, request.config, branch, run);
  const path = ingredientOverridesPath(request.dataDir);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  mergeIngredientOverrides(path, additions);
  const commitMsg = `drafts: ingredient-names batch ${shortBatch} (${Object.keys(additions).length} rows)`;
  await commitAndPush(request.repoRoot, request.config, branch, [path], commitMsg, run);

  const prUrl = await createPullRequest(request.repoRoot, request.config, branch, { title: commitMsg, body: buildIngredientPrBody(drafts, Object.keys(additions).length) }, run);

  const marked = await markPushed(
    shipping.map((entry) => entry.draft),
    (draft) => draft.ingredientSlug,
    (where, data) => prisma.ingredientNameDraft.updateMany({ where, data }),
    prUrl,
  );
  return { prUrl, branch, shippedDraftIds: marked.shipped, skipped: [...skipped, ...marked.changed] };
}

export interface CurrentOverridesPushResult {
  prUrl: string;
  branch: string;
  rowCount: number;
}

/** Push the *full current* ingredient-override state (every MANUAL row,
 *  rebuilt from the DB) to the configured upstream repo as a gh PR. Unlike
 *  `shipIngredientNamesUpstream`, this is not tied to draft status — it
 *  exports the accumulated override set so the operator can sync it into
 *  another instance or repo at any time. Merges additively (last write wins
 *  per slug), so entries already in the target repo that this instance
 *  doesn't have are preserved. Touches no draft rows. */
export async function pushCurrentOverridesUpstream(
  prisma: PrismaService,
  request: { dataDir: string; repoRoot: string; config: UpstreamShipConfig; run?: CommandRunner },
): Promise<CurrentOverridesPushResult> {
  const run = request.run ?? runCommand;
  guardPreconditions(request.config, request.repoRoot, run);
  const file = await buildCurrentIngredientOverrides(prisma);
  const rowCount = Object.keys(file).length;
  if (rowCount === 0) {
    throw new UpstreamShipError(
      'NO_CURRENT_OVERRIDES',
      'this instance has no MANUAL ingredient overrides to push',
    );
  }

  const branch = `overrides/sync-${Date.now().toString(36)}`;
  await prepareBranch(request.repoRoot, request.config, branch, run);
  const path = ingredientOverridesPath(request.dataDir);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  mergeIngredientOverrides(path, file);
  const commitMsg = `data: sync ingredient overrides (${rowCount} rows)`;
  await commitAndPush(request.repoRoot, request.config, branch, [path], commitMsg, run);

  const prUrl = await createPullRequest(request.repoRoot, request.config, branch, { title: commitMsg, body: buildCurrentOverridesPrBody(Object.keys(file)) }, run);

  return { prUrl, branch, rowCount };
}

/**
 * Mark as shipped the drafts that are still what was pushed. The branch was
 * pushed outside any transaction, so a draft may have been edited or reviewed
 * while it went: such a draft stays in the queue as the edit left it, and is
 * reported. The condition is part of the update itself.
 */
export async function markPushed<D extends { id: string; updatedAt: Date }>(
  pushed: readonly D[],
  slugOf: (draft: D) => string,
  update: (
    where: { id: string; status: 'APPROVED'; updatedAt: Date },
    data: { status: 'SHIPPED'; shippedAt: Date; shippedPRUrl: string },
  ) => Promise<{ count: number }>,
  prUrl: string,
): Promise<{ shipped: string[]; changed: Skipped[] }> {
  const shipped: string[] = [];
  const changed: Skipped[] = [];
  for (const draft of pushed) {
    const { count } = await update({ id: draft.id, status: 'APPROVED', updatedAt: draft.updatedAt }, { status: 'SHIPPED', shippedAt: new Date(), shippedPRUrl: prUrl });
    if (count === 1) shipped.push(draft.id);
    else changed.push({ draftId: draft.id, slug: slugOf(draft), reason: 'changed-while-shipping' });
  }
  return { shipped, changed };
}

// ── git plumbing ────────────────────────────────────────────────────────────

function guardPreconditions(config: UpstreamShipConfig, repoRoot: string, run: CommandRunner): void {
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
  if (!ghAvailable(run)) {
    throw new UpstreamShipError(
      'GH_MODE_UNAVAILABLE',
      '`gh` CLI not found on PATH',
    );
  }
  const url = resolveRemoteUrl(repoRoot, config.remote, run);
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

async function prepareBranch(repoRoot: string, config: UpstreamShipConfig, branch: string, run: CommandRunner): Promise<void> {
  git(run, repoRoot, ['fetch', config.remote, config.baseBranch]);
  git(run, repoRoot, ['checkout', '-B', branch, `${config.remote}/${config.baseBranch}`]);
}

async function commitAndPush(
  repoRoot: string,
  config: UpstreamShipConfig,
  branch: string,
  paths: string[],
  commitMessage: string,
  run: CommandRunner,
): Promise<void> {
  for (const p of paths) {
    git(run, repoRoot, ['add', '--', p]);
  }
  const commitEnv: NodeJS.ProcessEnv = {};
  if (config.authorName) commitEnv.GIT_AUTHOR_NAME = config.authorName;
  if (config.authorEmail) commitEnv.GIT_AUTHOR_EMAIL = config.authorEmail;
  if (config.authorName) commitEnv.GIT_COMMITTER_NAME = config.authorName;
  if (config.authorEmail) commitEnv.GIT_COMMITTER_EMAIL = config.authorEmail;
  // eslint-disable-next-line no-restricted-syntax -- subprocess plumbing: git needs the inherited PATH/HOME; we layer the commit identity on top
  git(run, repoRoot, ['commit', '-m', commitMessage], { ...process.env, ...commitEnv });
  git(run, repoRoot, ['push', '-u', config.remote, branch]);
}

async function createPullRequest(
  repoRoot: string,
  config: UpstreamShipConfig,
  branch: string,
  pr: { title: string; body: string },
  run: CommandRunner,
): Promise<string> {
  // The token reaches `gh` through its environment, never on the command line.
  // eslint-disable-next-line no-restricted-syntax -- subprocess plumbing: gh needs the inherited PATH/HOME; we layer GH_TOKEN on top
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.ghToken) env.GH_TOKEN = config.ghToken;
  const result = run('gh', ['pr', 'create', '--title', pr.title, '--body', pr.body, '--base', config.baseBranch, '--head', branch], { cwd: repoRoot, env });
  if (result.status !== 0) {
    throw new UpstreamShipError(
      'GH_PR_CREATE_FAILED',
      `gh pr create failed: ${result.stderr || result.stdout}`,
    );
  }
  const url = result.stdout.trim().split('\n').pop() ?? '';
  if (!/^https?:\/\//.test(url)) {
    throw new UpstreamShipError(
      'GH_PR_CREATE_FAILED',
      `unexpected gh output: ${result.stdout}`,
    );
  }
  return url;
}

/** Run one git command in `cwd`; a command that fails ends the ship and is named. */
function git(run: CommandRunner, cwd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const r = run('git', args, { cwd, ...(env ? { env } : {}) });
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

function buildCurrentOverridesPrBody(slugs: string[]): string {
  const preview = slugs.slice(0, 50).map((s) => `- ${s}`);
  const more = slugs.length > 50 ? [`- …and ${slugs.length - 50} more`] : [];
  return [
    `Full ingredient-name override state synced from a Diet App instance (${slugs.length} rows).`,
    '',
    'This is the complete current set of MANUAL ingredient translations on the ' +
      'instance, not an incremental draft batch. Merged additively into ' +
      '`data/ingredient-overrides.json` (last write wins per slug).',
    '',
    'Slugs:',
    ...preview,
    ...more,
  ].join('\n');
}
