import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Single source of truth for "is this recipe already known?" Called by every
 * code path that's about to write a new Recipe from an AI/swap surface
 * (`/recipes/ai-draft`, `applyIngredientSwap`, admin batch ship). The lookup
 * order matches plan §I.3:
 *
 *  1. Curated `Recipe` with matching fingerprint → reuse, no draft.
 *  2. The same user's existing personal Recipe → reuse, no draft.
 *  3. Pending or approved `RecipeDraft` with matching fingerprint → caller
 *     creates a fresh personal Recipe and we append it to
 *     `RecipeDraft.sourceRecipeIds`. No new draft.
 *  4. None match → caller creates personal Recipe + new `AI_USER` draft.
 *
 * The full transaction holds a Postgres advisory lock keyed on
 * `hashtext(fingerprint)` so two simultaneous "same swap" requests serialise:
 * the loser re-runs the lookup and now hits case 3 instead of racing to
 * insert a duplicate draft.
 */
@Injectable()
export class DedupService {
  private readonly logger = new Logger(DedupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run `body` inside a transaction that holds an advisory lock on the
   * fingerprint. Caller does the curated/personal lookups + (when needed)
   * inserts the personal Recipe and draft. The lock is released when the
   * transaction commits or rolls back.
   *
   * `body` is responsible for calling `findCuratedByFingerprint`,
   * `findUserRecipeByFingerprint`, and `findDraftByFingerprint` against the
   * transaction client (`tx`) it receives — these mirror the four cases in
   * the class doc.
   */
  withFingerprintLock<T>(
    fingerprint: string,
    body: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${fingerprint}))`,
      );
      return body(tx);
    });
  }

  /** Curated `Recipe` (origin = seed | curated) with this fingerprint, or null. */
  async findCuratedByFingerprint(
    tx: Prisma.TransactionClient,
    fingerprint: string,
  ): Promise<{ id: string } | null> {
    return tx.recipe.findFirst({
      where: {
        fingerprint,
        origin: { in: ['seed', 'curated'] },
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  /**
   * Existing personal Recipe owned by this user with the same fingerprint.
   * Soft-deleted variants are excluded so a user who deleted a previous
   * variant and re-creates the same swap gets a fresh row instead of being
   * reattached to a `deletedAt`-flagged recipe that recipes.get would 404 on.
   */
  async findUserRecipeByFingerprint(
    tx: Prisma.TransactionClient,
    fingerprint: string,
    userId: string,
  ): Promise<{ id: string } | null> {
    const draft = await tx.recipeDraft.findUnique({
      where: { fingerprint },
      select: { sourceRecipeIds: true },
    });
    if (!draft || draft.sourceRecipeIds.length === 0) return null;
    const recipe = await tx.recipe.findFirst({
      where: {
        id: { in: draft.sourceRecipeIds },
        createdByUserId: userId,
        deletedAt: null,
      },
      select: { id: true },
    });
    return recipe;
  }

  /**
   * Pending / approved `RecipeDraft` with this fingerprint (any source). The
   * caller appends its newly-created personal Recipe id to `sourceRecipeIds`
   * via `attachRecipeToDraft` rather than re-stashing the same shape.
   */
  findDraftByFingerprint(
    tx: Prisma.TransactionClient,
    fingerprint: string,
  ): Promise<{
    id: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';
    promotedRecipeId: string | null;
    sourceRecipeIds: string[];
  } | null> {
    return tx.recipeDraft.findUnique({
      where: { fingerprint },
      select: {
        id: true,
        status: true,
        promotedRecipeId: true,
        sourceRecipeIds: true,
      },
    });
  }

  /** Append `recipeId` to `RecipeDraft.sourceRecipeIds` without duplicates. */
  async attachRecipeToDraft(
    tx: Prisma.TransactionClient,
    draftId: string,
    recipeId: string,
  ): Promise<void> {
    const draft = await tx.recipeDraft.findUniqueOrThrow({
      where: { id: draftId },
      select: { sourceRecipeIds: true },
    });
    if (draft.sourceRecipeIds.includes(recipeId)) return;
    await tx.recipeDraft.update({
      where: { id: draftId },
      data: { sourceRecipeIds: { set: [...draft.sourceRecipeIds, recipeId] } },
    });
  }
}
