// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Every write of a profile that can change what it aims at writes that down (`noteTarget`): a writer that forgot it
 * would leave the days before its change judged by the change. The services are read as source: a write of a
 * profile whose data names a column the target is worked out from, or spreads an object into it, must sit in a
 * method that calls `noteTarget`. Data that is not written out in the call is a write the test cannot read, and is
 * named below with what it writes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TARGET_COLUMNS } from './profile-targets.js';

const SOURCE = join(__dirname, '..');

/** Writes whose data is not written out in the call, by `file:line` without the line, with what they write. */
const OPAQUE: Record<string, string> = {
  'meal-plans/plan-generation.service.ts': "the pantry's counters of a plan made (`pantryCount`)",
};

const WRITES = new Set(['update', 'updateMany', 'create', 'createMany', 'upsert']);

function sources(dir = SOURCE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : sources(join(dir, entry.name));
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [join(dir, entry.name)]
      : [];
  });
}

interface Write {
  at: string;
  file: string;
  /** Names a column of the target or spreads an object into the data; null where the data is not written out. */
  touches: boolean | null;
  /** The method or function it is in calls `noteTarget`. */
  notes: boolean;
}

/** The data objects of a write: `data`, or an upsert's `create` and `update`. */
function dataOf(call: ts.CallExpression): ts.Expression[] {
  const [arg] = call.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return arg ? [arg] : [];
  return arg.properties.flatMap((property) =>
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) &&
    ['data', 'create', 'update'].includes(property.name.text)
      ? [property.initializer]
      : [],
  );
}

function touches(data: ts.Expression[]): boolean | null {
  let opaque = false;
  for (const object of data) {
    const items = ts.isArrayLiteralExpression(object) ? object.elements : [object];
    for (const item of items) {
      if (!ts.isObjectLiteralExpression(item)) {
        opaque = true;
        continue;
      }
      for (const property of item.properties) {
        if (ts.isSpreadAssignment(property)) return true;
        const name =
          property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text
            : null;
        if (name !== null && name in TARGET_COLUMNS) return true;
      }
    }
  }
  return opaque ? null : false;
}

/** The outermost method or function a node is in: where its write's `noteTarget` is looked for. */
function enclosing(node: ts.Node): ts.Node {
  let found: ts.Node = node.getSourceFile();
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent)
    if (
      ts.isMethodDeclaration(at) ||
      ts.isFunctionDeclaration(at) ||
      ts.isConstructorDeclaration(at)
    )
      found = at;
  return found;
}

function writesOfProfiles(): Write[] {
  const writes: Write[] = [];
  for (const path of sources()) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('.profile.')) continue;
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        WRITES.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === 'profile'
      ) {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const name = relative(SOURCE, path);
        writes.push({
          at: `${name}:${line}`,
          file: name,
          touches: touches(dataOf(node)),
          notes: enclosing(node).getText().includes('noteTarget('),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return writes;
}

describe('writes of a profile', () => {
  const writes = writesOfProfiles();

  it('are found: the services that change what a profile aims at are read', () => {
    // Those of a profile made and changed, of a weight that becomes its own, and of the real expenditure taken.
    const touching = writes.filter((write) => write.touches === true).map((write) => write.file);
    expect(touching).toEqual(
      expect.arrayContaining([
        'profiles/profiles.service.ts',
        'weights/weights.service.ts',
        'diary/diary-summary.service.ts',
      ]),
    );
    expect(touching.length).toBeGreaterThanOrEqual(8);
  });

  it('that can change what it aims at write that down', () => {
    const forgetting = writes
      .filter((write) => write.touches === true && !write.notes)
      .map((write) => write.at);
    expect(forgetting).toEqual([]);
  });

  it('whose data the test cannot read are each named with what they write', () => {
    const unread = writes.filter((write) => write.touches === null && !write.notes);
    expect(unread.filter((write) => !(write.file in OPAQUE)).map((write) => write.at)).toEqual([]);
    // A name with no such write left is taken off.
    for (const file of Object.keys(OPAQUE))
      expect(unread.some((write) => write.file === file)).toBe(true);
  });
});
