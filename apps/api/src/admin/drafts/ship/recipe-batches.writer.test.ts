import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recipeBatchFilePath, writeRecipeBatch } from './recipe-batches.writer.js';

describe('recipeBatchFilePath', () => {
  it('resolves a server-generated batch id under data/recipes/', () => {
    const p = recipeBatchFilePath('/data', 'rec-2026-06-26T12-00-00-000Z-a1b2c3d4');
    expect(p).toBe('/data/recipes/rec-2026-06-26T12-00-00-000Z-a1b2c3d4.json');
  });

  // Defence-in-depth: this is a filesystem boundary. A future caller passing an
  // id with `..` or a path separator must never let the write escape the dir.
  it.each(['../escape', 'a/b', 'a\\b', '..', '', 'x/../../etc/passwd'])(
    'rejects unsafe batch id %j',
    (bad) => {
      expect(() => recipeBatchFilePath('/data', bad)).toThrow(/unsafe recipe batch id/);
    },
  );
});

describe('writeRecipeBatch', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recipe-batch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a batch file and refuses an unsafe id', () => {
    const { path, count } = writeRecipeBatch(dir, 'batch-1', []);
    expect(count).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([]);
    expect(() => writeRecipeBatch(dir, '../evil', [])).toThrow(/unsafe recipe batch id/);
  });
});
