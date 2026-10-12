// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PolicyReport } from '@diet-app/shared';

/**
 * One thing a page did, or would have done, against the content security
 * policy, as far as it is kept: enough to tell what to look at, and nothing a
 * sender could use to write into the log. A report says more (the whole
 * address of the page with its query, the policy, a sample of the code), and
 * that is dropped: an address can hold a token from a link in a mail, and a
 * sample a piece of the page.
 */
export interface Violation {
  /** `enforce` when the browser blocked it, `report` when the policy only watched. */
  disposition: 'enforce' | 'report';
  /** The directive that was broken, as `script-src-elem`. */
  directive: string;
  /** What was blocked: a word of the browser's (`inline`, `eval`), or where it came from, without a path. */
  blocked: string;
  /** The page it happened on: its path, without the query. */
  page: string;
  /** The file whose code did it, where the browser named one: a path of the application, or where else it came from, with line and column. */
  source: string;
}

/** The most violations one request is read for. A browser sends one report, or the handful it had waiting. */
export const MOST_PER_REQUEST = 20;

/** Letters, digits and what an address is written with. Whatever else a sender put in (a line break, an escape sequence) is left out. */
const plain = (value: string, most: number): string => value.replace(/[^\x21-\x7e]/g, '').slice(0, most);

function address(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A directive as a policy names one, or `unknown`. */
function directiveOf(value: string | undefined): string {
  // `violated-directive` holds the directive with its sources: the first word is the directive.
  const [named = ''] = (value ?? '').trim().split(/\s+/);
  return /^[a-z][a-z-]{2,40}$/.test(named) ? named : 'unknown';
}

/** What was blocked: a word of the browser's as it is, an address as where it leads without its path. */
function blockedOf(value: string | undefined): string {
  if (!value) return 'unknown';
  if (/^[a-z][a-z-]{1,30}$/.test(value)) return value;
  const url = address(value);
  if (!url) return 'unknown';
  // `data:` and `blob:` have nowhere they come from; the scheme says what they are.
  return plain(url.origin === 'null' ? url.protocol.replace(':', '') : url.origin, 120);
}

function sourceOf(file: string | undefined, page: URL | null, line: number | undefined, column: number | undefined): string {
  const url = address(file);
  if (!url) return '';
  const where = page && url.origin === page.origin ? url.pathname : url.origin === 'null' ? url.protocol.replace(':', '') : url.origin;
  return plain(where, 160) + (line === undefined ? '' : `:${line}${column === undefined ? '' : `:${column}`}`);
}

function violation(report: { page?: string; directive?: string; blocked?: string; file?: string; line?: number; column?: number; disposition?: string }): Violation {
  const page = address(report.page);
  return {
    disposition: report.disposition === 'report' ? 'report' : 'enforce',
    directive: directiveOf(report.directive),
    blocked: blockedOf(report.blocked),
    page: page ? plain(page.pathname, 120) : 'unknown',
    source: sourceOf(report.file, page, report.line, report.column),
  };
}

/** The violations a request reports, in either of the two shapes browsers send. */
export function violationsIn(body: PolicyReport): Violation[] {
  if (!Array.isArray(body)) {
    const report = body['csp-report'];
    return [
      violation({
        page: report['document-uri'],
        directive: report['effective-directive'] ?? report['violated-directive'],
        blocked: report['blocked-uri'],
        file: report['source-file'],
        line: report['line-number'],
        column: report['column-number'],
        disposition: report.disposition,
      }),
    ];
  }
  // A browser's queue holds reports of other kinds too (a feature that is going away, a crash).
  return body
    .flatMap((report) => (report.type === 'csp-violation' && report.body ? [report.body] : []))
    .slice(0, MOST_PER_REQUEST)
    .map((report) =>
      violation({
        page: report.documentURL,
        directive: report.effectiveDirective,
        blocked: report.blockedURL,
        file: report.sourceFile,
        line: report.lineNumber,
        column: report.columnNumber,
        disposition: report.disposition,
      }),
    );
}

/** What makes two violations the same kind: everything but the page they happened on. */
export const kindOf = (v: Violation): string => [v.disposition, v.directive, v.blocked, v.source].join(' ');

/** A violation in a line of the log. */
export function worded(v: Violation): string {
  const what = v.disposition === 'enforce' ? 'blocked' : 'would block';
  return `${v.directive} ${what} ${v.blocked} on ${v.page}${v.source ? ` (${v.source})` : ''}`;
}
