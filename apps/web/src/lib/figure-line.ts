// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The dot between the parts of a line, "Białko 136 z 134 g · tłuszcz 82 z 71 g", with a no-break
 * space before it: a narrow screen breaks only after it, so that no line starts with a dot.
 */
export const DOT = '\u00a0· ';

/** A short figure of such a line, "150 g" or "520 kcal", that a narrow screen keeps on one line. */
export const held = (figure: string): string => figure.replaceAll(' ', '\u00a0');
