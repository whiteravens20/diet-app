// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What enters the API from a request: every body, every query string and
 * every value in a path is checked before a controller sees it, and what a
 * client may send is bounded.
 *
 * The controllers are read as source. A body or a whole query string goes
 * through a schema of the shared contract; a single value of a path or of a
 * query goes through one of the named checks. Every schema found that way is
 * then walked: a text, a list or a number that a client may send without a
 * limit fails the test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as shared from '@diet-app/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE = join(__dirname, '..');

/** The checks a single value of a path or of a query may go through. */
const NAMED_CHECKS = new Set(['requiredUuid', 'requiredDate']);

interface Entry {
  /** Where: `file:line`, with the name of the parameter. */
  at: string;
  kind: 'Body' | 'Query' | 'Param';
  /** The schema of the contract it goes through, when it goes through one. */
  schema?: string;
  /** What is wrong with it, when something is. */
  problem?: string;
}

function controllers(dir = SOURCE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? controllers(join(dir, entry.name))
      : entry.name.endsWith('.controller.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** The names a file imports from the shared contract. */
function fromTheContract(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      (statement.moduleSpecifier as ts.StringLiteral).text !== '@diet-app/shared'
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/** The name an expression begins with: `RefreshRequest` of `RefreshRequest.prefault({})`. */
function rootOf(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression))
    return rootOf(expression.expression);
  return null;
}

function entriesOf(path: string): Entry[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const contract = fromTheContract(file);
  const found: Entry[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node)) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        const call = decorator.expression;
        if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
        const kind = call.expression.text;
        if (kind !== 'Body' && kind !== 'Query' && kind !== 'Param') continue;
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const entry: Entry = {
          at: `${relative(SOURCE, path)}:${line} ${node.name.getText()}`,
          kind,
        };
        const [first, second] = call.arguments;
        const named = first !== undefined && ts.isStringLiteral(first);
        const check = named ? second : first;

        if (!check) {
          entry.problem = 'is taken as it comes';
        } else if (ts.isIdentifier(check)) {
          if (!named || !NAMED_CHECKS.has(check.text))
            entry.problem = `goes through ${check.text}, which is none of the named checks`;
        } else if (
          ts.isNewExpression(check) &&
          ts.isIdentifier(check.expression) &&
          check.expression.text === 'ZodValidationPipe'
        ) {
          const schema = check.arguments?.[0] ? rootOf(check.arguments[0]) : null;
          if (!schema || !contract.has(schema))
            entry.problem = `is checked by ${check.arguments?.[0]?.getText() ?? 'nothing'}, which is not a schema of the shared contract`;
          else if (named)
            entry.problem =
              'checks one value with a schema: use a named check, or a schema for the whole query';
          else entry.schema = schema;
        } else {
          entry.problem = `goes through ${check.getText()}`;
        }
        if (kind === 'Param' && !named) entry.problem = 'takes every value of the path at once';
        found.push(entry);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const entries = controllers().flatMap(entriesOf);

/** Where a schema lets a client send something without a limit, as paths into the schema. */
function unbounded(schema: unknown, path: string, seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const zod = schema as {
    _zod: { def: Record<string, unknown> };
    maxLength?: number | null;
    minValue?: number | null;
    maxValue?: number | null;
  };
  const def = zod._zod.def;
  const checks = (
    (def.checks as { _zod: { def: { check: string; format?: string } } }[] | undefined) ?? []
  ).map((check) => check._zod.def);
  const inner = (key: string, suffix = ''): string[] =>
    unbounded(def[key], `${path}${suffix}`, seen);

  switch (def.type) {
    case 'string': {
      // A text in one of these forms cannot be long: the form says how long it is.
      const formats = [
        def.format,
        ...checks.filter((check) => check.check === 'string_format').map((check) => check.format),
      ];
      const fixed = formats.some((format) =>
        ['uuid', 'date', 'datetime', 'time'].includes(String(format)),
      );
      return fixed || typeof zod.maxLength === 'number' ? [] : [`${path}: a text of any length`];
    }
    case 'number': {
      const limited = (value: number | null | undefined): boolean =>
        typeof value === 'number' && Math.abs(value) < Number.MAX_SAFE_INTEGER;
      return limited(zod.minValue) && limited(zod.maxValue)
        ? []
        : [
            `${path}: a number without ${limited(zod.minValue) ? 'an upper' : limited(zod.maxValue) ? 'a lower' : 'any'} limit`,
          ];
    }
    case 'array':
      return [
        ...(checks.some((check) => check.check === 'max_length' || check.check === 'length_equals')
          ? []
          : [`${path}: a list of any length`]),
        ...inner('element', '[]'),
      ];
    case 'object':
      return Object.entries(def.shape as Record<string, unknown>).flatMap(([key, value]) =>
        unbounded(value, path ? `${path}.${key}` : key, seen),
      );
    case 'record': {
      // Keys out of a fixed set are as many as the set holds.
      const keys = (def.keyType as { _zod: { def: { type: string } } })._zod.def.type;
      return [
        ...(keys === 'enum' || keys === 'literal' ? [] : [`${path}: any number of keys`]),
        ...inner('valueType', '{}'),
      ];
    }
    case 'tuple':
      return (def.items as unknown[]).flatMap((item, index) =>
        unbounded(item, `${path}[${index}]`, seen),
      );
    case 'union':
      return (def.options as unknown[]).flatMap((option) => unbounded(option, path, seen));
    case 'intersection':
      return [...inner('left'), ...inner('right')];
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return inner('innerType');
    case 'pipe':
      return inner('in');
    case 'lazy':
      return unbounded((def.getter as () => unknown)(), path, seen);
    case 'boolean':
    case 'enum':
    case 'literal':
    case 'null':
    case 'undefined':
    case 'date':
      return [];
    default:
      return [`${path}: ${String(def.type)}, which says nothing about what may be sent`];
  }
}

describe('what a request may bring into the API', () => {
  it('is found: the controllers are read', () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(
      new Set(['Body', 'Query', 'Param']),
    );
  });

  it('is checked on the way in: a body and a query by a schema of the shared contract, a single value by a named check', () => {
    expect(
      entries.filter((entry) => entry.problem).map((entry) => `${entry.at} ${entry.problem}`),
    ).toEqual([]);
  });

  it('is bounded: no text or list of any length, no number without limits', () => {
    const schemas = [
      ...new Set(entries.flatMap((entry) => (entry.schema ? [entry.schema] : []))),
    ].sort();
    const open = schemas.flatMap((name) =>
      unbounded((shared as Record<string, unknown>)[name], '').map((where) => `${name} ${where}`),
    );

    expect(open).toEqual([]);
  });
});
