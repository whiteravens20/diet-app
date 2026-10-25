// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Table {
  name: string;
  /** The columns of each relation that point at another table. */
  pointers: string[][];
  /** The columns of each index, and whether it is the key or a unique one. */
  indexes: { columns: string[]; unique: boolean }[];
}

/** The tables of the schema, read from its text. */
function tablesOf(schema: string): Table[] {
  return [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}/gm)].map(([, name, body]) => {
    const columns = (list: string): string[] =>
      list.split(',').map((column) => column.trim().replace(/\(.*$/, ''));
    const indexes: Table['indexes'] = [...body!.matchAll(/@@(index|unique|id)\(\[([^\]]+)\]/g)].map(
      ([, kind, list]) => ({ columns: columns(list!), unique: kind !== 'index' }),
    );
    for (const [, column] of body!.matchAll(/^\s+(\w+)\s+\S+.*?@(?:id|unique)\b/gm))
      indexes.push({ columns: [column!], unique: true });
    const pointers = [...body!.matchAll(/@relation\([^)]*fields: \[([^\]]+)\]/g)].map(([, list]) =>
      columns(list!),
    );
    return { name: name!, pointers, indexes };
  });
}

const beginsWith = (columns: string[], first: string[]): boolean =>
  first.every((column, at) => columns[at] === column);

describe('the indexes of the schema', () => {
  const tables = tablesOf(readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8'));

  it('are read from every table', () => {
    expect(tables.length).toBeGreaterThan(30);
    const meals = tables.find((table) => table.name === 'PlannedMeal')!;
    expect(meals.pointers).toEqual(expect.arrayContaining([['dayId'], ['recipeId']]));
    expect(meals.indexes).toEqual(
      expect.arrayContaining([
        { columns: ['id'], unique: true },
        { columns: ['dayId'], unique: false },
      ]),
    );
  });

  // Deleting a row makes the database look for the rows that point at it; without an index that begins with the pointing columns it reads their whole table.
  it('begin, for every column that points at another table, with that column', () => {
    const without = tables.flatMap((table) =>
      table.pointers
        .filter((pointer) => !table.indexes.some((index) => beginsWith(index.columns, pointer)))
        .map((pointer) => `${table.name}(${pointer.join(', ')})`),
    );
    expect(without).toEqual([]);
  });

  // Such an index answers nothing the longer one does not, and is written at every change of a row.
  it('are never only the first columns of another index of the table', () => {
    const repeated = tables.flatMap((table) =>
      table.indexes
        .filter(
          (index) =>
            !index.unique &&
            table.indexes.some(
              (other) =>
                other !== index &&
                beginsWith(other.columns, index.columns) &&
                (other.unique || other.columns.length > index.columns.length),
            ),
        )
        .map((index) => `${table.name}(${index.columns.join(', ')})`),
    );
    expect(repeated).toEqual([]);
  });
});
