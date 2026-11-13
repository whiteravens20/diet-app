// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { holdLetters } from './held-letters';

/** A Polish word of one letter with a plain space after it, as the test of the application's texts finds one. */
const LOOSE_LETTER = /(?:^|[\s(„"»])[wziaouWZIAOU] (?=\S)/u;

describe('a text shown in Polish', () => {
  it('holds each word of one letter to the word after it', () => {
    expect(holdLetters('Pierś z kurczaka', 'pl')).toBe('Pierś z\u00a0kurczaka');
    expect(holdLetters('Kasza jaglana z tofu i pieczarkami z patelni', 'pl')).toBe(
      'Kasza jaglana z\u00a0tofu i\u00a0pieczarkami z\u00a0patelni',
    );
    expect(holdLetters('Owsianka o smaku jabłka a nie gruszki', 'pl')).toBe(
      'Owsianka o\u00a0smaku jabłka a\u00a0nie gruszki',
    );
    expect(holdLetters('Tuńczyk u Ani', 'pl')).toBe('Tuńczyk u\u00a0Ani');
  });

  it('holds a word of one letter that begins the text, follows another or an opening sign', () => {
    expect(holdLetters('W sosie własnym', 'pl')).toBe('W\u00a0sosie własnym');
    expect(holdLetters('Jabłka a i w cieście', 'pl')).toBe('Jabłka a\u00a0i\u00a0w\u00a0cieście');
    expect(holdLetters('Ryż (w woreczkach)', 'pl')).toBe('Ryż (w\u00a0woreczkach)');
    expect(holdLetters('Pieczarki „z lasu”', 'pl')).toBe('Pieczarki „z\u00a0lasu”');
    expect(holdLetters('Tofu, Szpinak i\u00a0Cebula z pieca', 'pl')).toBe(
      'Tofu, Szpinak i\u00a0Cebula z\u00a0pieca',
    );
    expect(holdLetters('Koniec.\nW tym', 'pl')).toBe('Koniec.\nW\u00a0tym');
  });

  it('leaves no word of one letter loose, as the test of the texts reads one', () => {
    for (const text of [
      'Pierś z kurczaka',
      'a i w domu',
      'Oliwa z oliwek i sól',
      '(o ile) u nas',
    ]) {
      expect(LOOSE_LETTER.test(holdLetters(text, 'pl')), text).toBe(false);
    }
  });

  it('changes nothing else', () => {
    expect(holdLetters('Witamina A', 'pl')).toBe('Witamina A');
    expect(holdLetters('Kasza jaglana', 'pl')).toBe('Kasza jaglana');
    expect(holdLetters('Zupa  z dyni', 'pl')).toBe('Zupa  z\u00a0dyni');
    expect(holdLetters('Sałatka z ', 'pl')).toBe('Sałatka z ');
    expect(holdLetters('', 'pl')).toBe('');
  });

  it('leaves a text in another language as it is', () => {
    expect(holdLetters('A bowl of oats with a pear', 'en')).toBe('A bowl of oats with a pear');
    expect(holdLetters('Pierś z kurczaka', 'en')).toBe('Pierś z kurczaka');
  });
});
