// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMirror } from './mirror-report.js';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const MANIFEST = { app: 'diet-app', version: '0.150.0', recipes: 183, names: 87 };

describe('how the copy of the instance files stands', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mirror-report-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const reported = (overrides: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({
        at: '2026-10-31T11:30:00Z',
        every: 3600,
        result: 'ok',
        pushedAt: '2026-10-30T18:02:00Z',
        ...overrides,
      }),
    );
  const copied = (manifest: unknown = MANIFEST) =>
    writeFileSync(join(dir, 'copy.json'), JSON.stringify(manifest));

  it('is off while the service has reported nothing', () => {
    expect(readMirror(dir, new Date('2026-10-31T10:00:00Z'), NOW)).toEqual({
      state: 'off',
      failure: null,
      checkedAt: null,
      pushedAt: null,
      copy: null,
    });
  });

  it('is current after a round that took what the files hold', () => {
    reported();
    copied();

    expect(readMirror(dir, new Date('2026-10-31T10:00:00Z'), NOW)).toEqual({
      state: 'current',
      failure: null,
      checkedAt: '2026-10-31T11:30:00Z',
      pushedAt: '2026-10-30T18:02:00Z',
      copy: { version: '0.150.0', recipes: 183, names: 87 },
    });
  });

  it('counts files of the second the round started in as taken', () => {
    reported();

    expect(readMirror(dir, new Date('2026-10-31T11:30:00.900Z'), NOW).state).toBe('current');
  });

  it('is behind when the files were written after the round started', () => {
    reported();

    expect(readMirror(dir, new Date('2026-10-31T11:30:01.000Z'), NOW).state).toBe('behind');
  });

  it.each(['clone', 'foreign', 'unreachable', 'push'])('says why a round failed: %s', (result) => {
    reported({ result });

    expect(readMirror(dir, null, NOW)).toMatchObject({ state: 'failed', failure: result });
  });

  it('says the instance holds nothing of its own, whatever its files', () => {
    reported({ result: 'empty', pushedAt: null });

    expect(readMirror(dir, new Date('2026-10-31T11:45:00Z'), NOW).state).toBe('empty');
  });

  it('counts the service as gone after three of its rounds without a report, also after a failure', () => {
    const atTheEdge = '2026-10-31T09:00:00Z';
    const past = '2026-10-31T08:59:59Z';
    reported({ at: atTheEdge });
    expect(readMirror(dir, null, NOW).state).toBe('current');

    reported({ at: past });
    expect(readMirror(dir, null, NOW)).toMatchObject({ state: 'silent', checkedAt: past });

    reported({ at: past, result: 'push' });
    expect(readMirror(dir, null, NOW)).toMatchObject({ state: 'silent', failure: null });

    reported({ at: '2026-10-31T11:00:00Z', every: 60 });
    expect(readMirror(dir, null, NOW).state).toBe('silent');
  });

  it('shows no copy where the repository has no manifest that can be read', () => {
    reported();
    copied({ app: 'something-else' });

    expect(readMirror(dir, null, NOW)).toMatchObject({ state: 'current', copy: null });
  });

  describe('reads what another container wrote as such', () => {
    it.each([
      ['not JSON', 'not json'],
      ['another shape', '{"at":"yesterday","every":3600,"result":"ok","pushedAt":null}'],
      ['a result of no known kind', '{"at":"2026-10-31T11:30:00Z","every":3600,"result":"<b>"}'],
    ])('takes %s for unreadable, and shows none of it', (_what, text) => {
      writeFileSync(join(dir, 'status.json'), text);

      expect(readMirror(dir, null, NOW)).toEqual({
        state: 'unreadable',
        failure: null,
        checkedAt: null,
        pushedAt: null,
        copy: null,
      });
    });

    it('does not read a large file', () => {
      reported({ padding: 'x'.repeat(5000) });

      expect(readMirror(dir, null, NOW).state).toBe('unreadable');
    });

    it('does not follow a link out of the volume', () => {
      const outside = join(dir, 'outside.json');
      writeFileSync(
        outside,
        JSON.stringify({ at: '2026-10-31T11:30:00Z', every: 3600, result: 'ok', pushedAt: null }),
      );
      symlinkSync(outside, join(dir, 'status.json'));

      expect(readMirror(dir, null, NOW).state).toBe('unreadable');
    });

    it('is not held up by a pipe nobody writes to', () => {
      execFileSync('mkfifo', [join(dir, 'status.json')]);

      expect(readMirror(dir, null, NOW).state).toBe('unreadable');
    });

    it('does not take a directory for a report', () => {
      mkdirSync(join(dir, 'status.json'));

      expect(readMirror(dir, null, NOW).state).toBe('unreadable');
    });
  });
});
