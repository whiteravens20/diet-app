// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The pull-request ship mode, with every command it would run handed to a
 * stand-in. No test here starts `git` or `gh`, and none can reach a remote:
 * the stand-in answers from a script and records what it was asked.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalogue } from '../../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../../testing/database.js';
import { aRecipeDraft, anIngredientNameDraft, asAdmin } from '../../../testing/factories.js';
import { createTestApp, type TestApp } from '../../../testing/test-app.js';
import { markPushed, shipIngredientNamesUpstream, shipRecipesUpstream, upstreamBlockedReason, type CommandRunner, type UpstreamShipConfig } from './upstream-mode.js';

const config: UpstreamShipConfig = {
  enabled: true,
  remote: 'mirror',
  baseBranch: 'main',
  ghToken: 'a-token-for-the-stand-in',
  authorName: 'Curator',
  authorEmail: 'curator@example.test',
};

interface Call {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** A stand-in for `git` and `gh`: everything succeeds unless `fail` names the command line it should refuse. */
function standIn(options: { remoteUrl?: string; fail?: RegExp; prUrl?: string } = {}): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    const line = `${command} ${args.join(' ')}`;
    if (options.fail?.test(line)) return { status: 1, stdout: '', stderr: `refused: ${line}` };
    if (line.startsWith('git remote get-url')) return { status: 0, stdout: `${options.remoteUrl ?? 'git@example.test:me/diet-content.git'}\n`, stderr: '' };
    if (line.startsWith('gh pr create')) return { status: 0, stdout: `Creating pull request\n${options.prUrl ?? 'https://example.test/me/diet-content/pull/7'}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('shipping as a pull request', () => {
  let t: TestApp;
  let repoRoot: string;
  let dataDir: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    repoRoot = mkdtempSync(join(tmpdir(), 'diet-app-upstream-'));
    dataDir = join(repoRoot, 'data');
  });

  const lines = (calls: Call[]): string[] => calls.map((call) => `${call.command} ${call.args.join(' ')}`);
  const request = (run: CommandRunner) => ({ dataDir, repoRoot, config, run });

  describe('while it is switched off', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('answers the refusal it documents, for a ship and for a push of the current overrides', async () => {
      // As in a container: the process runs where there is no checkout at all.
      vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);

      const ship = await t.http().post('/api/admin/drafts/ship').set(asAdmin).send({ kind: 'recipe', mode: 'upstream-pr' });
      const push = await t.http().post('/api/admin/drafts/ship/current-overrides/push').set(asAdmin);

      expect([ship.status, ship.body.error]).toEqual([409, 'SHIP_UPSTREAM_DISABLED']);
      expect([push.status, push.body.error]).toEqual([409, 'SHIP_UPSTREAM_DISABLED']);
      // The same reason the panel is given when it asks what is on offer.
      const offered = await t.http().get('/api/admin/drafts/ship/config').set(asAdmin).expect(200);
      expect(offered.body.modes.upstreamPr).toMatchObject({ available: false, reason: 'SHIP_UPSTREAM_DISABLED' });
    });

    it('says so before it looks for a repository or a tool', () => {
      const { run, calls } = standIn();

      expect(upstreamBlockedReason({ ...config, enabled: false }, null, run)).toBe('SHIP_UPSTREAM_DISABLED');
      expect(upstreamBlockedReason({ ...config, ghToken: null }, null, run)).toBe('SHIP_UPSTREAM_NO_TOKEN');
      expect(calls).toEqual([]);
    });
  });

  describe('what stands in its way when it is switched on', () => {
    it('is a missing tool, a missing repository, or a remote that is the project\'s own', () => {
      expect(upstreamBlockedReason(config, repoRoot, standIn({ fail: /^gh --version/ }).run)).toBe('GH_MODE_UNAVAILABLE');
      expect(upstreamBlockedReason(config, null, standIn().run)).toBe('SHIP_REPO_ROOT_NOT_FOUND');
      expect(upstreamBlockedReason(config, repoRoot, standIn({ remoteUrl: 'git@github.com:whiteravens20/diet-app.git' }).run)).toBe('SHIP_UPSTREAM_BLOCKED_CANONICAL');
      expect(upstreamBlockedReason(config, repoRoot, standIn().run)).toBeNull();
    });
  });

  it('writes the batch into the data directory, commits it on a branch of its own and opens the pull request', async () => {
    const draft = await aRecipeDraft(t, { status: 'APPROVED', batchId: 'rec-2026-10-11-abc' });
    const { run, calls } = standIn();

    const result = await shipRecipesUpstream(t.prisma, { kind: 'recipe', ...request(run) });

    expect(result).toMatchObject({ prUrl: 'https://example.test/me/diet-content/pull/7', shippedDraftIds: [draft.id], skipped: [] });
    expect(result.branch).toMatch(/^drafts\/recipes\/rec-2026-10-11-/);
    const [file] = readdirSync(join(dataDir, 'recipes'));
    expect(JSON.parse(readFileSync(join(dataDir, 'recipes', file!), 'utf8'))).toEqual([expect.objectContaining({ slug: draft.slug, title: { en: 'Oat bowl', pl: 'Owsianka' } })]);
    expect(lines(calls)).toEqual([
      'gh --version',
      'git remote get-url mirror',
      'git fetch mirror main',
      `git checkout -B ${result.branch} mirror/main`,
      `git add -- ${join(dataDir, 'recipes', file!)}`,
      'git commit -m drafts: recipes batch rec-2026-10-11 (1 rows)',
      `git push -u mirror ${result.branch}`,
      expect.stringMatching(/^gh pr create --title drafts: recipes batch rec-2026-10-11 \(1 rows\) --body [\s\S]+ --base main --head drafts\/recipes\//),
    ]);
    expect(await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'SHIPPED', shippedPRUrl: result.prUrl });
  });

  it('gives the token to the tool that opens the pull request through its environment, never on a command line', async () => {
    await aRecipeDraft(t, { status: 'APPROVED' });
    const { run, calls } = standIn();

    await shipRecipesUpstream(t.prisma, { kind: 'recipe', ...request(run) });

    expect(lines(calls).join('\n')).not.toContain(config.ghToken!);
    expect(calls.find((call) => call.args[0] === 'pr')!.env!.GH_TOKEN).toBe(config.ghToken);
    const commit = calls.find((call) => call.args[0] === 'commit')!;
    expect(commit.env).toMatchObject({ GIT_AUTHOR_NAME: 'Curator', GIT_AUTHOR_EMAIL: 'curator@example.test', GIT_COMMITTER_NAME: 'Curator' });
  });

  it('holds back a draft that breaks the rules, ships the rest, and marks only what shipped', async () => {
    const sound = await aRecipeDraft(t, { status: 'APPROVED' });
    const old = await aRecipeDraft(t, { status: 'APPROVED', titles: { en: 'Bowl <img src=x>', pl: 'Owsianka' } });
    const { run } = standIn();

    const result = await shipRecipesUpstream(t.prisma, { kind: 'recipe', ...request(run) });

    expect(result.shippedDraftIds).toEqual([sound.id]);
    expect(result.skipped).toEqual([{ draftId: old.id, slug: old.slug, reason: 'invalid-draft: titles.en: markup' }]);
    expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('APPROVED');
  });

  it('holds back a draft that would take the place of a recipe of the catalogue, and one that repeats another of the batch', async () => {
    const taking = await aRecipeDraft(t, { status: 'APPROVED', slug: 'milk-porridge', titles: { en: 'Another porridge', pl: 'Inna owsianka' } });
    const first = await aRecipeDraft(t, { status: 'APPROVED' });
    const repeat = await aRecipeDraft(t, { status: 'APPROVED', titles: { en: 'Oats again', pl: 'Znowu owsianka' } });
    const { run } = standIn();

    const result = await shipRecipesUpstream(t.prisma, { kind: 'recipe', ...request(run) });

    expect(result.shippedDraftIds).toEqual([first.id]);
    expect(result.skipped).toEqual([
      { draftId: taking.id, slug: 'milk-porridge', reason: 'slug-taken: milk-porridge' },
      { draftId: repeat.id, slug: repeat.slug, reason: `same-making-as: ${first.slug}` },
    ]);
  });

  it('does not mark as shipped a draft that changed while the branch was pushed', async () => {
    const pushed = await aRecipeDraft(t, { status: 'APPROVED' });
    const edited = await aRecipeDraft(t, { status: 'APPROVED' });
    // Edited and approved again after it was read for the pull request.
    await t.prisma.recipeDraft.update({ where: { id: edited.id }, data: { titles: { en: 'Oat bowl, improved', pl: 'Owsianka' } } });

    const marked = await markPushed(
      [pushed, edited],
      (draft) => draft.slug,
      (where, data) => t.prisma.recipeDraft.updateMany({ where, data }),
      'https://example.test/me/diet-content/pull/7',
    );

    expect(marked.shipped).toEqual([pushed.id]);
    expect(marked.changed).toEqual([{ draftId: edited.id, slug: edited.slug, reason: 'changed-while-shipping' }]);
    expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: edited.id } })).status).toBe('APPROVED');
  });

  it('marks only the drafts of an ingredient that shipped, not one of the same ingredient that was held back', async () => {
    const sound = await anIngredientNameDraft(t, { status: 'APPROVED' });
    const marked = await anIngredientNameDraft(t, { status: 'APPROVED', suggestions: { name: { pl: '<b>Kurczak</b>' } } });
    const { run } = standIn();

    const result = await shipIngredientNamesUpstream(t.prisma, { kind: 'ingredient-name', ...request(run) });

    expect(result.shippedDraftIds).toEqual([sound.id]);
    expect((await t.prisma.ingredientNameDraft.findUniqueOrThrow({ where: { id: marked.id } })).status).toBe('APPROVED');
  });

  it('pushes nothing when every approved draft breaks the rules', async () => {
    await aRecipeDraft(t, { status: 'APPROVED', servings: 500 });
    const { run, calls } = standIn();

    await expect(shipRecipesUpstream(t.prisma, { kind: 'recipe', ...request(run) })).rejects.toMatchObject({
      code: 'NO_VALID_DRAFTS',
      details: { skipped: [expect.objectContaining({ reason: 'invalid-draft: servings: servings-out-of-range' })] },
    });
    expect(lines(calls).filter((line) => /push|commit|pr create/.test(line))).toEqual([]);
  });

  it('refuses a remote that is the project\'s own repository, and touches nothing', async () => {
    const draft = await aRecipeDraft(t, { status: 'APPROVED' });
    const { run, calls } = standIn({ remoteUrl: 'https://github.com/whiteravens20/diet-app.git' });

    await expect(shipRecipesUpstream(t.prisma, { kind: 'recipe', ...request(run) })).rejects.toMatchObject({ code: 'SHIP_UPSTREAM_BLOCKED_CANONICAL' });

    expect(lines(calls)).toEqual(['gh --version', 'git remote get-url mirror']);
    expect(existsSync(dataDir)).toBe(false);
    expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('APPROVED');
  });

  it('leaves the drafts approved when the pull request cannot be opened', async () => {
    const draft = await aRecipeDraft(t, { status: 'APPROVED' });
    const { run } = standIn({ fail: /^gh pr create/ });

    await expect(shipRecipesUpstream(t.prisma, { kind: 'recipe', ...request(run) })).rejects.toMatchObject({ code: 'GH_PR_CREATE_FAILED' });
    expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('APPROVED');
  });

  it('leaves the drafts approved when a git command fails, and says which', async () => {
    const draft = await aRecipeDraft(t, { status: 'APPROVED' });
    const { run } = standIn({ fail: /^git push/ });

    await expect(shipRecipesUpstream(t.prisma, { kind: 'recipe', ...request(run) })).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('git push -u mirror') });
    expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('APPROVED');
  });

  it('merges the names of ingredients into the override file, in the languages they were reviewed in', async () => {
    const draft = await anIngredientNameDraft(t, { status: 'APPROVED', suggestions: { name: { pl: 'Filet z kurczaka', en: 'Chicken fillet' } } });
    const { run, calls } = standIn();

    const result = await shipIngredientNamesUpstream(t.prisma, { kind: 'ingredient-name', ...request(run) });

    expect(result.shippedDraftIds).toEqual([draft.id]);
    expect(JSON.parse(readFileSync(join(dataDir, 'ingredient-overrides.json'), 'utf8'))).toEqual({ 'chicken-breast': { name: { pl: 'Filet z kurczaka' } } });
    expect(lines(calls)).toContain(`git add -- ${join(dataDir, 'ingredient-overrides.json')}`);
    expect((await t.prisma.ingredientNameDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('SHIPPED');
  });
});
