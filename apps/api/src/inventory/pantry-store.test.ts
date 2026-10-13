// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { lockPantries } from './pantry-store.js';

/** A transaction that only notes the statements it is given. */
function aTransaction() {
  const $executeRaw = vi.fn((_statement: Prisma.Sql) => Promise.resolve(0));
  return { tx: { $executeRaw } as unknown as Prisma.TransactionClient, statements: () => $executeRaw.mock.calls.map(([statement]) => statement) };
}

describe('holding the pantries of several ingredients', () => {
  it('is one statement that takes them in the order of their ids, each once', async () => {
    const { tx, statements } = aTransaction();
    await lockPantries(tx, 'profile-1', ['c', 'a', 'b', 'a']);

    expect(statements()).toHaveLength(1);
    const [statement] = statements();
    expect(statement!.values).toEqual([['pantry:profile-1:a', 'pantry:profile-1:b', 'pantry:profile-1:c']]);
    // The order the keys are given in is the order they are taken in.
    expect(statement!.sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\(wanted\.key, 0\)\).*WITH ORDINALITY AS wanted\(key, place\) ORDER BY wanted\.place$/);
  });

  it('asks the database nothing when there is no ingredient', async () => {
    const { tx, statements } = aTransaction();
    await lockPantries(tx, 'profile-1', []);
    expect(statements()).toEqual([]);
  });
});
