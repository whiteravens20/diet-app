// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A text of the application as a piece of a pattern: its signs taken as they are, and each
 * space matching a plain or a no-break one. A page holds some words together with a no-break
 * space; a role's name reads it as a plain space, and the text of an element or of a label as
 * it is, so every pattern a browser test makes of a text is made with this.
 */
export const loose = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ \u00a0]/g, '[ \\u00a0]');
