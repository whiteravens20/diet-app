// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation } from './prisma-errors.js';

/** How long a key is kept with its account: a change that waits for a network is sent again within it. */
const IDEMPOTENCY_KEY_KEPT_MS = 7 * 86_400_000;

/** Keeps, in the transaction that wrote it, what a request sent with a key wrote: the id it is read again by. */
type KeepResult = (tx: Prisma.TransactionClient, resultId: string) => Promise<void>;

/** An addition as a request asks it, with the key it was sent with or none. */
interface Addition<T> {
  userId: string;
  /** The key the request was sent with; null for none. */
  key: string | null;
  /** The route and what the request asked: the same request sent again asks the same. */
  route: string;
  request: unknown;
  /** Writes the addition, calling `keep` in its transaction with what it wrote. */
  write: (keep: KeepResult) => Promise<T>;
  /** Answers the request sent again from what the first one wrote. */
  replay: (resultId: string) => Promise<T>;
}

/**
 * An addition written once however many times it is sent with its key
 * (`Idempotency-Key`). The key is kept in the transaction that writes the
 * addition, so both are kept or neither is: a request sent again under a key
 * that is kept writes nothing and is answered from what the first one wrote,
 * read again as it is now. The same key with another request is refused with
 * 422 `IDEMPOTENCY_KEY_REUSED`. Of two requests under one key at the same
 * moment, the database keeps one key: the transaction that loses rolls back,
 * its addition with it, and is answered as the request sent again. A request
 * without a key is written as it comes.
 */
export async function writeOnce<T>(prisma: PrismaService, addition: Addition<T>): Promise<T> {
  const { userId, key } = addition;
  if (key === null) return addition.write(async () => undefined);
  const digest = digestOf(addition.route, addition.request);
  const written = await resultOf(prisma, userId, key, digest);
  if (written !== null) return addition.replay(written);
  try {
    return await addition.write(async (tx, resultId) => {
      await tx.idempotencyKey.create({ data: { userId, key, digest, resultId } });
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const twin = await resultOf(prisma, userId, key, digest);
    if (twin === null) throw err;
    return addition.replay(twin);
  }
}

/** Removes the keys kept for longer than a week. Returns how many were removed. */
export async function pruneIdempotencyKeys(
  prisma: Pick<PrismaService, 'idempotencyKey'>,
  now = new Date(),
): Promise<number> {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_KEY_KEPT_MS) } },
  });
  return count;
}

/** What the request kept under `key` wrote, where it asked what `digest` says; null where none is kept under it. */
async function resultOf(
  prisma: PrismaService,
  userId: string,
  key: string,
  digest: string,
): Promise<string | null> {
  const kept = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
  if (kept === null) return null;
  if (kept.digest !== digest) {
    throw new UnprocessableEntityException({
      error: 'IDEMPOTENCY_KEY_REUSED',
      message: 'This Idempotency-Key was sent with another request.',
    });
  }
  return kept.resultId;
}

/** A hash of the route and of the request as it was read: the same request makes the same hash. */
function digestOf(route: string, request: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([route, request]))
    .digest('hex');
}
