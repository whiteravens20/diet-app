// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { foldedProductText, productCodeOf, wordsOfProductSearch } from './product-code.js';

describe('a barcode as it is read or typed', () => {
  it.each([
    ['an EAN-13', '5900512320359', '5900512320359'],
    ['an EAN-8', '20077242', '20077242'],
    ['a UPC-A, with the zero that makes it an EAN-13', '036000291452', '0036000291452'],
    ['an EAN-8 written out to 13 digits', '0000020077242', '20077242'],
    ['a code written out to 14 digits', '05900512320359', '5900512320359'],
    ['spaces and dashes a person types', ' 5900512-320359 ', '5900512320359'],
  ])('takes %s', (_, typed, code) => {
    expect(productCodeOf(typed)).toBe(code);
  });

  it.each([
    ['a last digit that does not close it', '5900512320358'],
    ['two digits changed places, the usual slip of a finger', '5900521320359'],
    ['a number of digits no such code has', '590051232'],
    ['14 digits that are not a code written out', '15900512320359'],
    ['letters', '59005123203a9'],
    ['nothing', ''],
    ['another script of digits', '٥٩٠٠٥١٢٣٢٠٣٥٩'],
  ])('refuses %s', (_, typed) => {
    expect(productCodeOf(typed)).toBeNull();
  });

  it('checks every digit of a code', () => {
    const code = '5900512320359';
    for (let place = 0; place < code.length; place += 1) {
      const other = (Number(code[place]) + 1) % 10;
      const typed = `${code.slice(0, place)}${other}${code.slice(place + 1)}`;
      expect(productCodeOf(typed), typed).toBeNull();
    }
  });
});

describe('a text as a search reads it', () => {
  it.each([
    ['Żubrówka ŁĄCKA', 'zubrowka lacka'],
    ['Weißbier Müller', 'weissbier muller'],
    ['Crème fraîche', 'creme fraiche'],
    ['Smørbrød', 'smorbrod'],
    ['Молоко «Домик»', 'молоко домик'],
    ['Γάλα ΦΑΓΕ', 'γαλα φαγε'],
    ['חלב תנובה', 'חלב תנובה'],
  ])('%s', (text, read) => {
    expect(foldedProductText(text)).toBe(read);
  });

  it('reads the same however a sign is composed', () => {
    expect(foldedProductText('café')).toBe(foldedProductText('café'));
    expect(foldedProductText('ガ')).toBe(foldedProductText('ガ'));
    expect(foldedProductText('한글')).toBe(foldedProductText('한글'.normalize('NFD')));
  });

  it('keeps what a person can search for in any script', () => {
    for (const text of ['牛乳', 'ヨーグルト', '우유', 'นม', 'दूध', 'حليب']) {
      expect(foldedProductText(text), text).not.toBe('');
      expect(foldedProductText(text)).toBe(foldedProductText(`  ${text}!`));
    }
  });
});

describe('the words of a search', () => {
  it('are those of the text as a search reads it', () => {
    expect(wordsOfProductSearch('Mleko  ŁACIATE')).toEqual(['mleko', 'laciate']);
  });

  it('hold at least one word an index can look for', () => {
    expect(wordsOfProductSearch('a b c')).toEqual([]);
    expect(wordsOfProductSearch('ab')).toEqual([]);
    expect(wordsOfProductSearch('a ser')).toEqual(['a', 'ser']);
    expect(wordsOfProductSearch('%%%')).toEqual([]);
  });

  it('take a word of two signs in a script that writes words that short', () => {
    expect(wordsOfProductSearch('牛乳')).toEqual(['牛乳']);
    expect(wordsOfProductSearch('우유')).toEqual(['우유']);
    expect(wordsOfProductSearch('ab')).toEqual([]);
    expect(wordsOfProductSearch('мо')).toEqual([]);
  });

  it('go no further than six', () => {
    expect(wordsOfProductSearch('jeden dwa trzy cztery piec szesc siedem')).toHaveLength(6);
  });
});
