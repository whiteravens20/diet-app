// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** A Polish word of one letter, as a word between two plain spaces is written: after an opening quote or bracket too. */
const ONE_LETTER = /^[(„"»]?[wziaouWZIAOU]$/u;

/** Whether a language keeps its words of one letter off a line's end: Polish. */
export function holdsLetters(locale: string): boolean {
  return locale.startsWith('pl');
}

/**
 * A text as a screen shows it: in Polish every word of one letter ("w", "z", "i", "a", "o", "u")
 * held to the word after it with a no-break space, so that a narrow screen never leaves it alone
 * at a line's end, as the application's own texts are written. Names that come from the data
 * (a recipe's title, an ingredient's name) and the lists the application joins pass through it
 * where they are shown; the data, a form's fields and what is shared keep their plain spaces.
 * Other languages are left as they are.
 */
export function holdLetters(text: string, locale: string): string {
  if (!holdsLetters(locale) || !text.includes(' ')) return text;
  const words = text.split(' ');
  return words.reduce((shown, word, index) => {
    // What ends the word before: after a no-break space or a new line the last of it is the word itself.
    const before = words[index - 1]!.split(/\s/u).at(-1)!;
    return `${shown}${ONE_LETTER.test(before) && word !== '' ? '\u00a0' : ' '}${word}`;
  });
}
