// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The codes the API refuses a request with, read from its source: every
 * `error: 'CODE'` there is, with the status the source gives beside it (the
 * exception it is thrown in, a status of its own, the place it has in a
 * table of statuses), and the sentence each language of the message
 * catalogue has for it. A client shows the sentence of its user's language
 * for the code it was answered with.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpStatus } from '@nestjs/common';
import ts from 'typescript';
import { SOURCE } from './routes.js';

const MESSAGES = join(SOURCE, '../../web/messages');

/** The status each of the framework's exceptions answers with. */
const STATUS: Record<string, number> = {
  BadRequestException: 400,
  UnauthorizedException: 401,
  ForbiddenException: 403,
  NotFoundException: 404,
  ConflictException: 409,
  GoneException: 410,
  PayloadTooLargeException: 413,
  UnprocessableEntityException: 422,
  InternalServerErrorException: 500,
  BadGatewayException: 502,
  ServiceUnavailableException: 503,
  GatewayTimeoutException: 504,
};

function sources(dir = SOURCE): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? (entry.name === 'testing' ? [] : sources(join(dir, entry.name))) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.bench.ts') ? [join(dir, entry.name)] : [],
    )
    .sort();
}

interface ErrorCode {
  code: string;
  /** The statuses it was found thrown with; none where the code is handed to whatever throws it. */
  statuses: number[];
}

/** A number that is written out, or named as the framework names a status. */
function statusIn(node: ts.Expression | undefined): number | null {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'HttpStatus') {
    const named = (HttpStatus as unknown as Record<string, unknown>)[node.name.text];
    return typeof named === 'number' ? named : null;
  }
  return null;
}

/** The status an object that holds a code comes with, where the source says it beside the code. */
function statusOf(object: ts.ObjectLiteralExpression): number | null {
  // Written into the object itself.
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && (property.name.text === 'status' || property.name.text === 'statusCode')) {
      const written = statusIn(property.initializer);
      if (written !== null) return written;
    }
  }
  const holder = object.parent;
  // The first argument of an exception: the status is the exception's, or its second argument.
  if (ts.isNewExpression(holder) && holder.arguments?.[0] === object && ts.isIdentifier(holder.expression)) {
    return STATUS[holder.expression.text] ?? (holder.expression.text === 'HttpException' ? statusIn(holder.arguments[1]) : null);
  }
  // The answer a table keeps for a status: `429: { error: … }`.
  if (ts.isPropertyAssignment(holder) && ts.isNumericLiteral(holder.name)) return Number(holder.name.text);
  return null;
}

/** Every code of the API's source, in the order of the alphabet. */
function readErrorCodes(): ErrorCode[] {
  const found = new Map<string, Set<number>>();
  for (const path of sources()) {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'error') continue;
          if (!ts.isStringLiteralLike(property.initializer) || !/^[A-Z][A-Z0-9_]+$/.test(property.initializer.text)) continue;
          const statuses = found.get(property.initializer.text) ?? new Set<number>();
          const status = statusOf(node);
          if (status !== null) statuses.add(status);
          found.set(property.initializer.text, statuses);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...found].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, statuses]) => ({ code, statuses: [...statuses].sort((a, b) => a - b) }));
}

/** The codes with their sentences, as a document to read. */
export function errorsDocument(): string {
  const sentences = (locale: string): Record<string, string> => (JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8')) as { errors: Record<string, string> }).errors;
  const [en, pl] = [sentences('en'), sentences('pl')];
  const cell = (text: string | undefined): string => (text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const codes = readErrorCodes();
  return [
    '# The codes a request is refused with',
    '',
    'Written by `npm run contract` from the source of the API and from the message catalogue (`apps/web/messages/`); a test fails when this file is not what the command writes.',
    '',
    `A refusal is an \`ApiError\`: its \`error\` is one of the ${codes.length} codes below, and its \`message\` an English sentence for a log. What a person is shown is the sentence of their language: \`errors.<code>\` in the catalogue of that language, which has one for every code. A text in braces is filled in from the \`details\` of the answer where the code has any. The status is the one the source gives beside the code; a code that is handed on to whatever throws it is listed without one.`,
    '',
    '| Code | Status | In English | In Polish |',
    '|---|---|---|---|',
    ...codes.map(({ code, statuses }) => `| \`${code}\` | ${statuses.join(', ')} | ${cell(en[code])} | ${cell(pl[code])} |`),
    '',
  ].join('\n');
}
