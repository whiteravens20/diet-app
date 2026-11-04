// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { PRODUCT_SEARCH } from './constants.js';

/**
 * A product's barcode, and the words a product is searched by. This file needs
 * nothing of the contract but its limits: a page that checks what a person
 * types takes it from `@diet-app/shared/product-code`, and loads no schema with
 * it.
 */

/** The digit that closes a code of the EAN and UPC family, for the digits before it. */
function closingDigit(digits: string): number {
  let sum = 0;
  for (let place = 0; place < digits.length; place += 1) {
    const digit = digits.charCodeAt(digits.length - 1 - place) - 48;
    sum += place % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * A code as Open Food Facts keeps it, from the way it was read or typed: EAN-8
 * and EAN-13 as they are, UPC-A with the zero that makes it an EAN-13, and an
 * EAN-8 written out to 13 or a code written out to 14 digits without what pads
 * them. Null for anything else, and for a code whose last digit does not close
 * it, which is what a slip of a finger or a bad read gives.
 */
export function productCodeOf(typed: string): string | null {
  let code = typed.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(code)) return null;
  if (code.length === 14 && code.startsWith('0')) code = code.slice(1);
  if (code.length === 12) code = `0${code}`;
  if (code.length === 13 && code.startsWith('00000')) code = code.slice(5);
  if (code.length !== 8 && code.length !== 13) return null;
  return closingDigit(code.slice(0, -1)) === Number(code.at(-1)) ? code : null;
}

/**
 * A text as a search reads it: small letters, without diacritics, whatever the
 * script, words of letters and digits with one space between them. What is
 * searched for and what it is searched in go through this alike.
 */
export function foldedProductText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/ß/g, 'ss')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/đ/g, 'd')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The scripts that write a word in few signs: a word of them is one at two. */
const WRITTEN_IN_FEW_SIGNS =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

/** How many words of a search are looked for: more say nothing further. */
const MOST_WORDS = 6;

/** The words of a search, or none where not one of them is long enough to be looked for in an index. */
export function wordsOfProductSearch(query: string): string[] {
  const words = foldedProductText(query).split(' ').filter(Boolean).slice(0, MOST_WORDS);
  const longEnough = words.some((word) => {
    const signs = [...word].length;
    return (
      signs >= PRODUCT_SEARCH.leastLetters ||
      (signs >= PRODUCT_SEARCH.leastSigns && WRITTEN_IN_FEW_SIGNS.test(word))
    );
  });
  return longEnough ? words : [];
}
