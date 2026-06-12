/**
 * "Pull ingredient overrides from a repo" — the reverse of the local ship.
 *
 * Fetches an `ingredient-overrides.json` from a repo the operator names in the
 * admin panel, validates its shape, and applies every row to the live DB as
 * `source = 'MANUAL'` `IngredientTranslation` rows (the same write the
 * local-mode ship uses). Unknown slugs (ingredients this instance doesn't
 * have) are skipped and reported, never fatal.
 *
 * Source forms accepted:
 *   - `owner/repo` or `owner/repo@branch` — resolved against the GitHub
 *     contents API (`data/ingredient-overrides.json`). Works for public repos
 *     anonymously and for private repos when a PAT is configured in env.
 *   - a full `http(s)` raw URL — fetched directly (e.g. a gitea/gitlab raw
 *     link). The PAT is only ever attached to GitHub hosts, so it can't leak
 *     to an arbitrary server.
 *
 * Container-friendly: a plain HTTP fetch, no git working tree needed, so it
 * runs inside the Docker image (unlike upstream-PR push).
 */
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { IngredientOverrideFile } from './ingredient-overrides.writer.js';

const OVERRIDES_PATH = 'data/ingredient-overrides.json';

export class PullOverridesError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PullOverridesResult {
  source: string;
  resolvedUrl: string;
  /** Slugs whose translations were upserted. */
  applied: number;
  /** Per-locale translation rows written. */
  rowsWritten: number;
  /** Slugs in the file that this instance has no ingredient for. */
  skippedSlugs: string[];
  /** Total slugs in the fetched file. */
  total: number;
}

interface ResolvedSource {
  url: string;
  /** True when the host is GitHub — the only place the PAT is attached. */
  github: boolean;
  /** True for the GitHub contents API (needs the raw Accept header). */
  api: boolean;
}

/** Turn an operator-entered source into a fetchable URL. */
export function resolvePullSource(source: string): ResolvedSource {
  const s = source.trim();
  if (/^https?:\/\//i.test(s)) {
    let host: string;
    try {
      host = new URL(s).host.toLowerCase();
    } catch {
      throw new PullOverridesError('INVALID_PULL_SOURCE', `not a valid URL: ${source}`);
    }
    const github =
      host === 'github.com' || host === 'api.github.com' || host.endsWith('.githubusercontent.com');
    return { url: s, github, api: host === 'api.github.com' };
  }
  // owner/repo or owner/repo@branch
  const m = /^([\w.-]+)\/([\w.-]+?)(?:@([\w./-]+))?$/.exec(s);
  if (m) {
    const [, owner, repo, ref = 'main'] = m;
    return {
      url:
        `https://api.github.com/repos/${owner}/${repo}/contents/${OVERRIDES_PATH}` +
        `?ref=${encodeURIComponent(ref)}`,
      github: true,
      api: true,
    };
  }
  throw new PullOverridesError(
    'INVALID_PULL_SOURCE',
    `not a repo (owner/repo[@branch]) or a raw URL: ${source}`,
  );
}

/** Fetch + parse + validate the override file for `source`. The PAT is sent
 *  only to GitHub hosts. */
export async function fetchOverrides(
  source: string,
  token: string | null,
): Promise<{ file: IngredientOverrideFile; resolvedUrl: string }> {
  const resolved = resolvePullSource(source);
  const headers: Record<string, string> = {
    'user-agent': 'diet-app',
    accept: resolved.api ? 'application/vnd.github.raw' : 'application/json',
  };
  if (resolved.api) headers['x-github-api-version'] = '2022-11-28';
  if (resolved.github && token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(resolved.url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new PullOverridesError(
      'PULL_FETCH_FAILED',
      `could not fetch ${resolved.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 404) {
    throw new PullOverridesError(
      'PULL_FETCH_FAILED',
      `${resolved.url} returned 404 — check the repo, branch, and that ${OVERRIDES_PATH} exists ` +
        '(private repos need OVERRIDES_PULL_TOKEN set).',
    );
  }
  if (!res.ok) {
    throw new PullOverridesError(
      'PULL_FETCH_FAILED',
      `fetching ${resolved.url} returned HTTP ${res.status}`,
    );
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new PullOverridesError(
      'PULL_SHAPE_INVALID',
      `${resolved.url} did not return valid JSON`,
    );
  }
  const parsed = IngredientOverrideFile.safeParse(raw);
  if (!parsed.success) {
    throw new PullOverridesError(
      'PULL_SHAPE_INVALID',
      `${resolved.url} is not a valid ingredient-overrides file: ${parsed.error.message}`,
    );
  }
  return { file: parsed.data, resolvedUrl: resolved.url };
}

/** Apply a parsed override file to the live DB as MANUAL translations. Mirrors
 *  the local-mode ship's per-locale upsert; unknown slugs are skipped. */
export async function applyOverridesToDb(
  prisma: PrismaService,
  file: IngredientOverrideFile,
): Promise<{ applied: number; rowsWritten: number; skippedSlugs: string[] }> {
  const skippedSlugs: string[] = [];
  let applied = 0;
  let rowsWritten = 0;

  for (const [slug, entry] of Object.entries(file)) {
    const target = await prisma.ingredient.findFirst({ where: { slug }, select: { id: true } });
    if (!target) {
      skippedSlugs.push(slug);
      continue;
    }
    const storageHintMap = (entry.storageHint ?? {}) as Record<string, string>;
    for (const [locale, name] of Object.entries(entry.name as Record<string, string>)) {
      const storageHint = storageHintMap[locale] ?? null;
      await prisma.ingredientTranslation.upsert({
        where: { ingredientId_locale: { ingredientId: target.id, locale } },
        create: { ingredientId: target.id, locale, name, storageHint, source: 'MANUAL' },
        update: { name, storageHint, source: 'MANUAL' },
      });
      rowsWritten += 1;
    }
    applied += 1;
  }

  return { applied, rowsWritten, skippedSlugs };
}

/** Full pull: fetch from `source`, apply to DB, return a summary. */
export async function pullOverrides(
  prisma: PrismaService,
  source: string,
  token: string | null,
): Promise<PullOverridesResult> {
  const { file, resolvedUrl } = await fetchOverrides(source, token);
  const total = Object.keys(file).length;
  const { applied, rowsWritten, skippedSlugs } = await applyOverridesToDb(prisma, file);
  return { source, resolvedUrl, applied, rowsWritten, skippedSlugs, total };
}
