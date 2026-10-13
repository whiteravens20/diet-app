// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Pulling the names of ingredients from a repository: the reverse of shipping
 * them. The administrator names a source in the panel; its
 * `ingredient-overrides.json` is fetched, and every entry that passes the
 * rules for names is stored as a name approved by people, as a local ship
 * stores one.
 *
 * A source is one of:
 *   - `owner/repo` or `owner/repo@branch`: `data/ingredient-overrides.json`
 *     of that GitHub repository, read through the contents API. Public
 *     repositories need nothing; a private one needs a token in the settings.
 *   - a full `http(s)` address of the file, on any host.
 *
 * The address comes from the panel, so the file is fetched with the care of
 * `common/outbound-http.ts`: only from a public address, unless the operator
 * named the host in the settings; no redirect is followed; a file that is too
 * large is not read. The token is sent to GitHub's hosts and to no other.
 *
 * What the file holds is no more trusted than what a model writes: an entry
 * that breaks a rule for names is refused and reported, an entry for an
 * ingredient this instance does not have is skipped and reported, and neither
 * stops the rest.
 */
import { outboundRequest, OutboundRequestError, type Resolver } from '../../../common/outbound-http.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { IngredientOverrideFile } from './ingredient-overrides.writer.js';
import { shippableIngredientName } from './shippable.js';

const OVERRIDES_PATH = 'data/ingredient-overrides.json';
/** Longest wait for the file, and the largest file that is read: many times what the names of a full catalogue take. */
const PULL_TIMEOUT_MS = 15_000;
const PULL_MAX_BYTES = 2_000_000;

/** What the settings say about pulling. */
export interface PullPolicy {
  /** Sent to GitHub's hosts only. */
  token: string | null;
  /**
   * Hosts the operator named, as `host` or `host:port`. A source on one of
   * them is fetched even from an address that is not public.
   */
  allowedHosts: readonly string[];
}

/** The codes a pull of name overrides is refused with. */
export type PullOverridesCode = 'INVALID_PULL_SOURCE' | 'PULL_ADDRESS_NOT_PUBLIC' | 'PULL_FETCH_FAILED' | 'PULL_SHAPE_INVALID';

export class PullOverridesError extends Error {
  constructor(
    public readonly code: PullOverridesCode,
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
  /** Entries that break a rule for names, each with the reason. Nothing of them was stored. */
  refused: { slug: string; reason: string }[];
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

/** True when the operator named the host of `url` in the settings. */
function operatorNamed(url: URL, allowedHosts: readonly string[]): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const withPort = url.port ? `${hostname}:${url.port}` : hostname;
  return allowedHosts.some((entry) => {
    const named = entry.trim().toLowerCase();
    return named === hostname || named === withPort;
  });
}

/** Fetch the override file of `source` and check its shape. */
async function fetchOverrides(
  source: string,
  policy: PullPolicy,
  resolve?: Resolver,
): Promise<{ file: IngredientOverrideFile; resolvedUrl: string }> {
  const resolved = resolvePullSource(source);
  const headers: Record<string, string> = {
    'user-agent': 'diet-app',
    accept: resolved.api ? 'application/vnd.github.raw' : 'application/json',
  };
  if (resolved.api) headers['x-github-api-version'] = '2022-11-28';
  if (resolved.github && policy.token) headers.authorization = `Bearer ${policy.token}`;

  let res: Awaited<ReturnType<typeof outboundRequest>>;
  try {
    res = await outboundRequest(
      resolved.url,
      {
        method: 'GET',
        headers,
        timeoutMs: PULL_TIMEOUT_MS,
        maxBytes: PULL_MAX_BYTES,
        publicOnly: !operatorNamed(new URL(resolved.url), policy.allowedHosts),
      },
      resolve,
    );
  } catch (err) {
    if (err instanceof OutboundRequestError && err.failure === 'address_not_public') {
      throw new PullOverridesError(
        'PULL_ADDRESS_NOT_PUBLIC',
        `${resolved.url} is not at a public address. A source inside your own network is fetched only when its host is named in OVERRIDES_PULL_ALLOWED_HOSTS.`,
      );
    }
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
  if (res.status >= 300 && res.status < 400) {
    throw new PullOverridesError('PULL_FETCH_FAILED', `${resolved.url} answered with a redirect (HTTP ${res.status}), which is not followed: name the address of the file itself`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new PullOverridesError(
      'PULL_FETCH_FAILED',
      `fetching ${resolved.url} returned HTTP ${res.status}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
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

/**
 * Store the names of an override file as names approved by people: all of
 * them, or none when the database refuses one.
 *
 * Each entry is held to the rules for names in the languages it carries. One
 * that breaks a rule is refused, one for an ingredient this instance does not
 * have is skipped, and both are reported.
 */
export async function applyOverridesToDb(
  prisma: PrismaService,
  file: IngredientOverrideFile,
): Promise<{ applied: number; rowsWritten: number; skippedSlugs: string[]; refused: { slug: string; reason: string }[] }> {
  const skippedSlugs: string[] = [];
  const refused: { slug: string; reason: string }[] = [];
  let applied = 0;
  let rowsWritten = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const [slug, entry] of Object.entries(file)) {
        const checked = shippableIngredientName({ suggestions: entry, locales: Object.keys(entry.name) });
        if (!checked.ok) {
          refused.push({ slug, reason: checked.reason });
          continue;
        }
        const target = await tx.ingredient.findFirst({ where: { slug }, select: { id: true } });
        if (!target) {
          skippedSlugs.push(slug);
          continue;
        }
        const hints: Record<string, string> = checked.content.storageHint ?? {};
        for (const [locale, name] of Object.entries(checked.content.name)) {
          const storageHint = hints[locale] ?? null;
          await tx.ingredientTranslation.upsert({
            where: { ingredientId_locale: { ingredientId: target.id, locale } },
            create: { ingredientId: target.id, locale, name, storageHint, source: 'MANUAL' },
            update: { name, storageHint, source: 'MANUAL' },
          });
          rowsWritten += 1;
        }
        applied += 1;
      }
    },
    { timeout: 120_000 },
  );

  return { applied, rowsWritten, skippedSlugs, refused };
}

/** The whole pull: fetch the file of `source`, store what passes, and say what happened to each entry. */
export async function pullOverrides(
  prisma: PrismaService,
  source: string,
  policy: PullPolicy,
  resolve?: Resolver,
): Promise<PullOverridesResult> {
  const { file, resolvedUrl } = await fetchOverrides(source, policy, resolve);
  return { source, resolvedUrl, total: Object.keys(file).length, ...(await applyOverridesToDb(prisma, file)) };
}
