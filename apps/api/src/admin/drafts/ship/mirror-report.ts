// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How the copy of the instance's files in a git repository stands, from what
 * the `mirror` service reports after each round.
 *
 * The service writes `status.json` and `copy.json` into a volume of their own,
 * which the API mounts read-only. That is all the API sees of the service: not
 * its key, not its clone, and not the address of the repository.
 *
 * The volume is what another container wrote, so it is read as such: no link is
 * followed, nothing but a small regular file is read, a pipe cannot hold the
 * process, and only fields that pass the schema go on.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { InstanceMirror, MirrorFailure } from '@diet-app/shared';
import { InstanceManifest } from './instance-export.js';

const STATUS_FILE = 'status.json';
const COPY_FILE = 'copy.json';

/** Both files are a few lines. */
const MOST_BYTES = 4096;

/** After this many of its rounds without a report, the service counts as gone. */
const SILENT_AFTER_ROUNDS = 3;

const Report = z.object({
  /** When the round started. */
  at: z.string().datetime(),
  /** How many seconds its rounds are apart. */
  every: z.number().int().min(1).max(604_800),
  result: z.enum(['ok', 'empty', 'clone', 'foreign', 'unreachable', 'push']),
  pushedAt: z.string().datetime().nullable(),
});
type Report = z.infer<typeof Report>;

/** The text of a small regular file; undefined where there is none, null where it cannot be read. */
function readSmallFile(path: string): string | null | undefined {
  let file: number;
  try {
    // Without O_NONBLOCK, opening a pipe nobody writes to would hold the API.
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > MOST_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  } finally {
    closeSync(file);
  }
}

/** A file of the report by its schema; undefined where there is none, null where it cannot be read. */
function readReportFile<T>(path: string, schema: z.ZodType<T>): T | null | undefined {
  const text = readSmallFile(path);
  if (text === undefined || text === null) return text;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The state of the copy from what the service last reported, at the moment `now`. */
function judgeMirror(
  report: Report | null | undefined,
  copy: InstanceManifest | null,
  filesWrittenAt: Date | null,
  now: Date,
): InstanceMirror {
  const nothing = { failure: null, checkedAt: null, pushedAt: null, copy: null };
  if (report === undefined) return { state: 'off', ...nothing };
  if (report === null) return { state: 'unreadable', ...nothing };

  const known = {
    checkedAt: report.at,
    pushedAt: report.pushedAt,
    copy: copy ? { version: copy.version, recipes: copy.recipes, names: copy.names } : null,
  };
  const at = Date.parse(report.at);
  if (now.getTime() - at > SILENT_AFTER_ROUNDS * report.every * 1000) {
    return { state: 'silent', failure: null, ...known };
  }
  if (report.result === 'empty') return { state: 'empty', failure: null, ...known };
  if (report.result !== 'ok') {
    return { state: 'failed', failure: report.result satisfies MirrorFailure, ...known };
  }
  // The report's time has whole seconds: a file of the same second counts as taken.
  const behind = filesWrittenAt !== null && Math.floor(filesWrittenAt.getTime() / 1000) * 1000 > at;
  return { state: behind ? 'behind' : 'current', failure: null, ...known };
}

/** The copy as the report directory says, with the time the instance's files were last written. */
export function readMirror(
  reportDir: string,
  filesWrittenAt: Date | null,
  now: Date,
): InstanceMirror {
  return judgeMirror(
    readReportFile(join(reportDir, STATUS_FILE), Report),
    readReportFile(join(reportDir, COPY_FILE), InstanceManifest) ?? null,
    filesWrittenAt,
    now,
  );
}
