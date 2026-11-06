// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Texts as the eye reads them, for a test: a line of figures holds its pairs with no-break spaces
 * (`lib/figure-line.ts`), which a reader sees as plain ones.
 */

/** A text with its no-break spaces read as plain ones. */
export const plain = (text: string | null | undefined): string =>
  (text ?? '').replaceAll('\u00a0', ' ');

/** A name to find an element by, each space matching a plain or a no-break one; `start` matches its beginning only. */
export function spaced(text: string, { start = false }: { start?: boolean } = {}): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '[ \\u00a0]');
  return new RegExp(`^${escaped}${start ? '' : '$'}`);
}
