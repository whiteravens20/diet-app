// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** What a cell of a table holds: a text, a number, or nothing. */
export type Cell = string | number | null;

/**
 * How a language's spreadsheets read a file of separated values: what stands
 * between two cells, and the sign before the decimals of a number. Where the
 * decimal sign is a comma, cells are parted by a semicolon.
 */
export interface CsvDialect {
  separator: ',' | ';';
  decimal: '.' | ',';
}

/** The dialect of each language the application is shown in. */
export const CSV_DIALECTS: Record<string, CsvDialect> = {
  en: { separator: ',', decimal: '.' },
  pl: { separator: ';', decimal: ',' },
};

/** A text that a spreadsheet would take for a formula: it begins with a sign that starts one. */
const STARTS_A_FORMULA = /^[=+\-@\t\r]/;

function written(cell: Cell, dialect: CsvDialect): string {
  if (cell === null) return '';
  // A number is written without grouping, to the hundredth, with the decimal sign of the dialect.
  if (typeof cell === 'number')
    return Number.isFinite(cell)
      ? String(Math.round(cell * 100) / 100).replace('.', dialect.decimal)
      : '';
  // A name somebody typed is text, whatever it begins with: with an apostrophe before it a spreadsheet does not work it out.
  const text = STARTS_A_FORMULA.test(cell) ? `'${cell}` : cell;
  return /["\r\n]/.test(text) || text.includes(dialect.separator) || text !== text.trim()
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

/**
 * A table as a file of separated values that a spreadsheet opens: one line a
 * row, the lines ended as such files end them, the whole preceded by the mark
 * that says it is UTF-8 (without it a spreadsheet reads "ż" as two signs).
 */
export function csvOf(rows: readonly (readonly Cell[])[], dialect: CsvDialect): string {
  return `﻿${rows.map((row) => row.map((cell) => written(cell, dialect)).join(dialect.separator)).join('\r\n')}\r\n`;
}
