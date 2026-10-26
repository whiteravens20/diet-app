// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { CSV_DIALECTS, csvOf } from './csv';

const en = CSV_DIALECTS.en!;
const pl = CSV_DIALECTS.pl!;
/** The lines of a file, without the mark it begins with. */
const lines = (file: string): string[] => file.slice(1).split('\r\n');

describe('a table as a file of separated values', () => {
  it('begins with the mark of UTF-8, and ends every row as such files end them', () => {
    const file = csvOf(
      [
        ['Name', 'Amount'],
        ['Ryż', 200],
      ],
      en,
    );

    expect(file.charCodeAt(0)).toBe(0xfeff);
    expect(lines(file)).toEqual(['Name,Amount', 'Ryż,200', '']);
  });

  it('parts cells and writes decimals as the spreadsheets of the language read them', () => {
    expect(lines(csvOf([['Jajko', 2.5, 1200]], en))[0]).toBe('Jajko,2.5,1200');
    expect(lines(csvOf([['Jajko', 2.5, 1200]], pl))[0]).toBe('Jajko;2,5;1200');
  });

  it('writes a number without grouping and to the hundredth, and nothing for what is not there', () => {
    expect(lines(csvOf([[12150, 0.1 + 0.2, 79.456, null, Number.NaN]], en))[0]).toBe(
      '12150,0.3,79.46,,',
    );
  });

  it('quotes a text that holds the separator, a quote or a line break, or that begins or ends with a space', () => {
    expect(lines(csvOf([['Rice, white', 'the "good" one', ' padded ']], en))[0]).toBe(
      '"Rice, white","the ""good"" one"," padded "',
    );
    expect(csvOf([['two\nlines']], en)).toBe('﻿"two\nlines"\r\n');
    // In the other dialect a comma parts nothing, and a semicolon does.
    expect(lines(csvOf([['Rice, white', 'a; b']], pl))[0]).toBe('Rice, white;"a; b"');
  });

  it.each([
    '=1+1',
    '+48 600',
    '-5 kg',
    '@name',
    '\tcell',
    '=HYPERLINK("http://example.test","click")',
  ])('keeps a spreadsheet from working out a name that begins like a formula: %s', (name) => {
    const [cell] = lines(csvOf([[name]], pl));

    expect(cell!.replace(/^"/, '').startsWith("'")).toBe(true);
    expect(cell).toContain(name.replaceAll('"', '""'));
  });

  it('leaves a negative number a number', () => {
    expect(lines(csvOf([[-120]], en))[0]).toBe('-120');
  });
});
