// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Pulling the names of ingredients from a repository: the reverse of shipping
 * them. The administrator names a source in the panel; its
 * `ingredient-overrides.json` is fetched, and every entry is stored as a name
 * approved by people, as a local ship stores one.
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
 * An entry for an ingredient this instance does not have is skipped and
 * reported; it does not stop the rest.
 */
import { outboundRequest, OutboundRequestError, type Resolver } from '../../../common/outbound-http.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { IngredientOverrideFile } from './ingredient-overrides.writer.js';

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
export async function fetchOverrides(
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
