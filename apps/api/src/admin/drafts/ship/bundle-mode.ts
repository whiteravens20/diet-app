/**
 * Bundle (download) ship mode — universal fallback when neither local nor
 * upstream-pr fits the operator's workflow.
 *
 * The runner serialises the approved drafts into a single JSON envelope
 * matching the on-disk shapes used by `data/recipes/<batchId>.json` and
 * `data/ingredient-overrides.json`, stashes it in memory behind an
 * HMAC-signed one-shot token (10-minute TTL), and returns a download URL.
 *
 * Token format: `<expiresAtMs>.<hex(payloadId)>.<hex(hmacSha256)>` — the
 * payload is held in a Map keyed by `payloadId`. The Map is the source of
 * truth, the signature is the unforgeability guarantee, and TTL is enforced
 * both by the signature claim and by a cleanup pass.
 *
 * Stash is process-local (in-memory) — fine for a single-replica self-hosted
 * instance; multi-replica deployments would back this with Redis. The plan
 * doesn't ask for multi-replica support and the rest of the curation queue
 * (runners with in-memory single-flight state) makes the same assumption.
 *
 * Download is not "mark shipped" — the operator must explicitly POST the
 * mark-shipped action separately. The plan calls for this because download
 * != commitment.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import {
  IngredientOverrideEntry,
  type IngredientOverrideFile,
} from './ingredient-overrides.writer.js';
import { type ShippedRecipe } from './recipe-batches.writer.js';

export interface BundleShipRequest {
  kind: 'recipe' | 'ingredient-name';
  batchIds?: string[];
}

export interface BundlePayload {
  kind: 'recipe' | 'ingredient-name';
  batchId: string;
  generatedAt: string;
  draftIds: string[];
  recipes?: ShippedRecipe[];
  ingredientOverrides?: IngredientOverrideFile;
}

export interface BundleStashEntry {
  payload: BundlePayload;
  expiresAtMs: number;
}

export interface BundleShipResult {
  downloadUrl: string;
  token: string;
  expiresAt: string;
  draftIds: string[];
}

const TTL_MS = 10 * 60 * 1000;

const stash = new Map<string, BundleStashEntry>();

/** Read a payload by token. Verifies signature + expiry. Returns null when
 *  the token is invalid, expired, or the payload was already consumed. */
export function consumeBundleToken(token: string, secret: string): BundlePayload | null {
  const parsed = parseToken(token, secret);
  if (!parsed) return null;
  const entry = stash.get(parsed.payloadId);
  if (!entry) return null;
  if (entry.expiresAtMs < Date.now()) {
    stash.delete(parsed.payloadId);
    return null;
  }
  stash.delete(parsed.payloadId);
  return entry.payload;
}

export async function shipRecipesBundle(
  prisma: PrismaService,
  request: BundleShipRequest & { kind: 'recipe' },
  secret: string,
  appUrl: string,
): Promise<BundleShipResult> {
  const where = {
    status: 'APPROVED' as const,
    ...(request.batchIds && request.batchIds.length > 0
      ? { batchId: { in: request.batchIds } }
      : {}),
  };
  const drafts = await prisma.recipeDraft.findMany({ where, orderBy: { createdAt: 'asc' } });
  if (drafts.length === 0) {
    throw new Error('NO_APPROVED_DRAFTS');
  }
  const recipes: ShippedRecipe[] = drafts.map((d) => ({
    slug: d.slug,
    title: d.titles as Record<string, string>,
    description: d.descriptions as Record<string, string>,
    servings: d.servings,
    mealTypes: d.mealTypes as ShippedRecipe['mealTypes'],
    dietTags: d.dietTags as ShippedRecipe['dietTags'],
    prepMinutes: d.prepMinutes,
    cookMinutes: d.cookMinutes,
    difficulty: d.difficulty,
    ingredients: (d.ingredientsJson ?? []) as ShippedRecipe['ingredients'],
    steps: d.steps as Record<string, string[]>,
  }));

  const batchId = `bundle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const payload: BundlePayload = {
    kind: 'recipe',
    batchId,
    generatedAt: new Date().toISOString(),
    draftIds: drafts.map((d) => d.id),
    recipes,
  };
  return stashAndUrl(payload, secret, appUrl);
}

export async function shipIngredientNamesBundle(
  prisma: PrismaService,
  request: BundleShipRequest & { kind: 'ingredient-name' },
  secret: string,
  appUrl: string,
): Promise<BundleShipResult> {
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
    throw new Error('NO_APPROVED_DRAFTS');
  }
  const overrides: IngredientOverrideFile = {};
  const validDraftIds: string[] = [];
  for (const d of drafts) {
    const parsed = IngredientOverrideEntry.safeParse(d.suggestions);
    if (parsed.success) {
      overrides[d.ingredientSlug] = parsed.data;
      validDraftIds.push(d.id);
    }
  }
  if (Object.keys(overrides).length === 0) {
    throw new Error('NO_VALID_DRAFTS');
  }
  const batchId = `bundle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const payload: BundlePayload = {
    kind: 'ingredient-name',
    batchId,
    generatedAt: new Date().toISOString(),
    draftIds: validDraftIds,
    ingredientOverrides: overrides,
  };
  return stashAndUrl(payload, secret, appUrl);
}

/** Flips the draft rows to SHIPPED after the operator confirms they've
 *  committed the downloaded bundle. Called from a separate endpoint so
 *  download != commitment, per plan §E. */
export async function markBundleShipped(
  prisma: PrismaService,
  kind: 'recipe' | 'ingredient-name',
  draftIds: string[],
): Promise<{ updated: number }> {
  if (draftIds.length === 0) return { updated: 0 };
  if (kind === 'recipe') {
    const r = await prisma.recipeDraft.updateMany({
      where: { id: { in: draftIds }, status: 'APPROVED' },
      data: { status: 'SHIPPED', shippedAt: new Date(), shippedPRUrl: null },
    });
    return { updated: r.count };
  }
  const r = await prisma.ingredientNameDraft.updateMany({
    where: { id: { in: draftIds }, status: 'APPROVED' },
    data: { status: 'SHIPPED', shippedAt: new Date(), shippedPRUrl: null },
  });
  return { updated: r.count };
}

function stashAndUrl(
  payload: BundlePayload,
  secret: string,
  appUrl: string,
): BundleShipResult {
  pruneExpired();
  const payloadId = randomBytes(16).toString('hex');
  const expiresAtMs = Date.now() + TTL_MS;
  stash.set(payloadId, { payload, expiresAtMs });
  const token = mintToken(payloadId, expiresAtMs, secret);
  return {
    downloadUrl: `${appUrl.replace(/\/$/, '')}/api/admin/drafts/ship/download/${token}`,
    token,
    expiresAt: new Date(expiresAtMs).toISOString(),
    draftIds: payload.draftIds,
  };
}

function mintToken(payloadId: string, expiresAtMs: number, secret: string): string {
  const body = `${expiresAtMs}.${payloadId}`;
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function parseToken(
  token: string,
  secret: string,
): { payloadId: string; expiresAtMs: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [expStr, payloadId, sigHex] = parts;
  const expiresAtMs = Number(expStr);
  if (!Number.isInteger(expiresAtMs) || expiresAtMs <= 0) return null;
  if (!/^[0-9a-f]+$/i.test(payloadId)) return null;
  const expected = createHmac('sha256', secret).update(`${expStr}.${payloadId}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sigHex, 'hex');
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return { payloadId, expiresAtMs };
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, entry] of stash) {
    if (entry.expiresAtMs < now) stash.delete(id);
  }
}

/** Test seam — clear the stash between tests. */
export function __clearBundleStashForTests(): void {
  stash.clear();
}
