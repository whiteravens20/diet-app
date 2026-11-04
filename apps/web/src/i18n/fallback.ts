// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** The texts of a language, nested by the parts of their keys. */
export type Messages = { [key: string]: string | Messages };

/**
 * The texts of a language with the English ones under them: a key the language
 * lacks is shown in English, at whatever depth it is, and never as the key itself.
 * A text the language has stands as it is.
 */
export function withEnglishUnder(english: Messages, own: Messages): Messages {
  const merged: Messages = { ...english };
  for (const [key, text] of Object.entries(own)) {
    const under = merged[key];
    merged[key] =
      typeof text === 'object' && typeof under === 'object' ? withEnglishUnder(under, text) : text;
  }
  return merged;
}
