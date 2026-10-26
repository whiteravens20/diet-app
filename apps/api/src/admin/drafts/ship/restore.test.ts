// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instanceDataState } from './restore.js';

const aDirectory = () => mkdtempSync(join(tmpdir(), 'diet-app-instance-state-'));
/** The superuser may write anywhere: what a mode forbids cannot be seen as one. */
const asSuperuser = process.getuid?.() === 0;

describe("what the instance's data directory holds", () => {
  it('is counted from the files that can be read, and a file that cannot counts for nothing', () => {
    const dir = aDirectory();
    mkdirSync(join(dir, 'recipes'));
    writeFileSync(
      join(dir, 'recipes', 'ship-1.json'),
      JSON.stringify([{ slug: 'a' }, { slug: 'b' }]),
    );
    writeFileSync(join(dir, 'recipes', 'ship-2.json'), '{ not json');
    writeFileSync(join(dir, 'recipes', 'notes.txt'), 'not a batch');
    writeFileSync(
      join(dir, 'ingredient-overrides.json'),
      JSON.stringify({ tomato: { name: { pl: 'Pomidor' } }, salmon: { name: { pl: 'Łosoś' } } }),
    );

    expect(instanceDataState(dir)).toEqual({
      writable: true,
      recipeFiles: 1,
      recipes: 2,
      names: 2,
    });
  });

  it('is nothing, and writable, where the directory is not made yet but can be', () => {
    expect(instanceDataState(join(aDirectory(), 'instance-data'))).toEqual({
      writable: true,
      recipeFiles: 0,
      recipes: 0,
      names: 0,
    });
  });

  it.skipIf(asSuperuser)(
    'is not writable where the API may not write: a ship there leaves no copy',
    () => {
      const dir = aDirectory();
      chmodSync(dir, 0o500);

      expect(instanceDataState(dir).writable).toBe(false);
      // Nor where the directory would have to be made inside one that is closed.
      expect(instanceDataState(join(dir, 'instance-data')).writable).toBe(false);
    },
  );
});
