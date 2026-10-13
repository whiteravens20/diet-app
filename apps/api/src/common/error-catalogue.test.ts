// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The codes a request is refused with, and the sentences the message
 * catalogue has for them.
 *
 * Every code the API's source can answer with (read the way the published
 * list of codes reads them, so a code that is handed on by a variable counts
 * too) has a sentence in each language: without one a client shows the
 * server's English message. And every sentence is for a code of the API or
 * one of the few the web application makes itself, so that a code that left
 * the API does not leave its sentence behind.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readErrorCodes } from '../../scripts/contract/errors.js';

const API_SRC = resolve(__dirname, '..');
const MESSAGES_DIR = resolve(API_SRC, '../../../apps/web/messages');

/** What the web application says of failures the API did not name: no answer at all, a failure without a code, the fields of a failed check, a wait. */
const OF_THE_WEB = ['GENERIC', 'NETWORK', 'VALIDATION_FAILED_FIELDS', 'HELD_UP_MINUTES', 'HELD_UP_SECONDS'];

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
  /** The codes of the API's source. */
  let thrown: Set<string>;

  // Reading them takes the compiler: once, with time of its own.
  beforeAll(() => {
    thrown = new Set(readErrorCodes().map(({ code }) => code));
  }, 60_000);

  it('every thrown code has a matching key in en.json AND pl.json', async () => {
    const [en, pl] = await Promise.all([loadLocaleErrors('en'), loadLocaleErrors('pl')]);

    // No messages dir found (running outside the repo) — skip gracefully.
    if (en.size === 0 && pl.size === 0) return;

    const missingEn = [...thrown].filter((c) => !en.has(c)).sort();
    const missingPl = [...thrown].filter((c) => !pl.has(c)).sort();
    expect(missingEn, `Missing in en.json#errors: ${missingEn.join(', ')}`).toEqual([]);
    expect(missingPl, `Missing in pl.json#errors: ${missingPl.join(', ')}`).toEqual([]);
  });

  it('every sentence is for a code the API can answer with, or for one of the web application\'s own', async () => {
    const en = await loadLocaleErrors('en');
    if (en.size === 0) return;

    expect([...en].filter((code) => !thrown.has(code) && !OF_THE_WEB.includes(code)).sort()).toEqual([]);
    expect(OF_THE_WEB.filter((code) => thrown.has(code))).toEqual([]);
  });

  it('finds the codes that are handed on by a variable as well as the ones written where they are thrown', () => {
    expect(thrown.size).toBeGreaterThan(140);
    // Written in an exception; passed on from an error that was caught; handed to the function that throws.
    expect([...thrown]).toEqual(expect.arrayContaining(['PLAN_NOT_FOUND', 'OLLAMA_HOST_NOT_ALLOWED', 'PULL_FETCH_FAILED', 'INVALID_SUBSTITUTION']));
  });
});
