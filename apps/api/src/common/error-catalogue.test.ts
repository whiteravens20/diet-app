/**
 * Catalogue-completeness gate for F14.
 *
 * Scans every `throw new *Exception(...)` site in apps/api/src for a string
 * `error:` code, then asserts each unique code has a matching row under
 * `errors.*` in both apps/web/messages/en.json and pl.json.
 *
 * Prevents drift: if a backend throw adds a new code and the client
 * messages file doesn't grow a key for it, the client falls back to the
 * server's English `message` instead of the locale string. This test
 * forces that not to happen.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_SRC = resolve(__dirname, '..');
const MESSAGES_DIR = resolve(API_SRC, '../../../apps/web/messages');

const SCAN_EXCLUDES = new Set([
  // Excluded so this test never accidentally pulls codes out of itself.
  'error-catalogue.test.ts',
]);

async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await walkTs(join(dir, entry.name))));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !SCAN_EXCLUDES.has(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Pull `error: 'CODE_NAME'` (single or double quotes) from a source file. */
function extractCodes(source: string): string[] {
  const re = /\berror:\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
  const codes: string[] = [];
  for (const m of source.matchAll(re)) codes.push(m[1]);
  return codes;
}

async function loadCodes(): Promise<Set<string>> {
  const files = await walkTs(API_SRC);
  const codes = new Set<string>();
  await Promise.all(
    files.map(async (file) => {
      const text = await readFile(file, 'utf-8');
      for (const code of extractCodes(text)) codes.add(code);
    }),
  );
  return codes;
}

interface MessagesShape {
  errors?: Record<string, string>;
}

async function loadLocaleErrors(locale: 'en' | 'pl'): Promise<Set<string>> {
  // Skip when running outside the repo (e.g. published packages).
  try {
    await stat(MESSAGES_DIR);
  } catch {
    return new Set();
  }
  const raw = await readFile(join(MESSAGES_DIR, `${locale}.json`), 'utf-8');
  const parsed = JSON.parse(raw) as MessagesShape;
  return new Set(Object.keys(parsed.errors ?? {}));
}

describe('error-code catalogue', () => {
  it('every thrown code has a matching key in en.json AND pl.json', async () => {
    const [thrown, en, pl] = await Promise.all([
      loadCodes(),
      loadLocaleErrors('en'),
      loadLocaleErrors('pl'),
    ]);

    // No messages dir found (running outside the repo) — skip gracefully.
    if (en.size === 0 && pl.size === 0) return;

    const missingEn = [...thrown].filter((c) => !en.has(c)).sort();
    const missingPl = [...thrown].filter((c) => !pl.has(c)).sort();
    expect(missingEn, `Missing in en.json#errors: ${missingEn.join(', ')}`).toEqual([]);
    expect(missingPl, `Missing in pl.json#errors: ${missingPl.join(', ')}`).toEqual([]);
  });

  it('extracts at least one code (sanity check the scanner is finding files)', async () => {
    const thrown = await loadCodes();
    expect(thrown.size, 'expected at least one error code in apps/api/src').toBeGreaterThan(0);
  });
});
