// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Bundle ship mode: the approved drafts as a file, for an operator who commits
 * it to a repository by hand. Always available: it needs no remote and no
 * setting.
 *
 * The answer carries the file itself, in the shape the data directory takes:
 * for recipes the batch that goes into `data/recipes/` under the name given,
 * for the names of ingredients the entries to merge into
 * `data/ingredient-overrides.json`. The administrator's panel asks with the
 * administrator's credentials and saves what it gets; nothing is kept on the
 * server, and there is no link that works without credentials.
 *
 * Making a bundle ships nothing. The operator marks the drafts as shipped in
 * a step of its own, once the file is committed, so that a download taken by
 * mistake changes nothing.
 */
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { IngredientOverrideFile } from './ingredient-overrides.writer.js';
import { sortRecipesForFile } from './library.js';
import type { ShippedRecipe } from './recipe-batches.writer.js';
import { shippableIngredientName, sortForShipping, type Skipped } from './shippable.js';

export interface BundleShipRequest {
  kind: 'recipe' | 'ingredient-name';
  batchIds?: string[];
}

export interface BundleShipResult {
  kind: 'recipe' | 'ingredient-name';
  batchId: string;
  /** The drafts the bundle holds. */
  draftIds: string[];
  /** Approved drafts left out, each with the reason. */
  skipped: Skipped[];
  /** The name to save the file under. */
  fileName: string;
  /** What the file holds. */
  content: ShippedRecipe[] | IngredientOverrideFile;
}

const approved = (request: BundleShipRequest) => ({
  status: 'APPROVED' as const,
  ...(request.batchIds && request.batchIds.length > 0 ? { batchId: { in: request.batchIds } } : {}),
});

const newBatchId = (): string => `bundle-${new Date().toISOString().replace(/[:.]/g, '-')}`;

export async function shipRecipesBundle(prisma: PrismaService, request: BundleShipRequest & { kind: 'recipe' }): Promise<BundleShipResult> {
  const drafts = await prisma.recipeDraft.findMany({ where: approved(request), orderBy: { createdAt: 'asc' } });
  if (drafts.length === 0) throw new Error('NO_APPROVED_DRAFTS');
  const { shipping, skipped } = await sortRecipesForFile(prisma, drafts);
  if (shipping.length === 0) throw new Error('NO_VALID_DRAFTS');

  const batchId = newBatchId();
  return {
    kind: 'recipe',
    batchId,
    draftIds: shipping.map((entry) => entry.draft.id),
    skipped,
    fileName: `${batchId}.json`,
    content: shipping.map((entry) => entry.content),
  };
}

export async function shipIngredientNamesBundle(
  prisma: PrismaService,
  request: BundleShipRequest & { kind: 'ingredient-name' },
): Promise<BundleShipResult> {
  const drafts = await prisma.ingredientNameDraft.findMany({ where: approved(request), orderBy: { createdAt: 'asc' } });
  if (drafts.length === 0) throw new Error('NO_APPROVED_DRAFTS');
  const { shipping, skipped } = sortForShipping(drafts, shippableIngredientName, (draft) => draft.ingredientSlug);
  if (shipping.length === 0) throw new Error('NO_VALID_DRAFTS');

  const content: IngredientOverrideFile = {};
  for (const entry of shipping) content[entry.draft.ingredientSlug] = entry.content;
  return {
    kind: 'ingredient-name',
    batchId: newBatchId(),
    draftIds: shipping.map((entry) => entry.draft.id),
    skipped,
    fileName: 'ingredient-overrides.json',
    content,
  };
}

/**
 * Mark drafts as shipped once the operator has committed the bundle they
 * were in. Only approved drafts change: the status is part of the update's
 * own condition, so a draft that an edit sent back to review in the meantime
 * stays where the edit left it.
 */
export async function markBundleShipped(
  prisma: PrismaService,
  kind: 'recipe' | 'ingredient-name',
  draftIds: string[],
): Promise<{ updated: number }> {
  if (draftIds.length === 0) return { updated: 0 };
  const where = { id: { in: draftIds }, status: 'APPROVED' as const };
  const data = { status: 'SHIPPED' as const, shippedAt: new Date(), shippedPRUrl: null };
  const result = kind === 'recipe' ? await prisma.recipeDraft.updateMany({ where, data }) : await prisma.ingredientNameDraft.updateMany({ where, data });
  return { updated: result.count };
}
