// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The lock of one draft. A review, an edit, a deletion and a ship each hold
 * the draft's row until their transaction ends, so they take turns: whichever
 * comes second reads the draft as the first one left it.
 */
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export async function lockRecipeDraft(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "RecipeDraft" WHERE "id" = ${id} FOR UPDATE`;
}

export async function lockIngredientNameDraft(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "IngredientNameDraft" WHERE "id" = ${id} FOR UPDATE`;
}
