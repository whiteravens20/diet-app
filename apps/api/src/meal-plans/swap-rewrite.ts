// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Locale } from '@diet-app/shared';

/**
 * Per-locale clone rewriter for `applyIngredientSwap`. It has two modes:
 *
 *  - **Mode A (default, no-AI):** localized string substitution. Replace the
 *    OLD ingredient's translated name with the NEW one's translated name in
 *    each translation row, then rewrite the title via the locale-specific
 *    `variantTitle` template. Free, deterministic, works without a provider.
 *  - **Mode B:** on top of Mode A, a model rewords the description and the
 *    steps of one language around the new ingredient; the title still comes
 *    from the template.
 *
 * The variantTitle template is hardcoded per locale on
 * the backend because (a) next-intl runs on the web, not here, and (b)
 * keeping the template typed against the `Locale` enum makes adding a new
 * locale a typecheck error if the template is forgotten.
 */

export interface RecipeLocaleSlice {
  title: string;
  description: string;
  steps: string[];
}

export interface SwapRewriteInput {
  /** RecipeTranslation rows on the source recipe, by locale. */
  source: ReadonlyMap<Locale, RecipeLocaleSlice>;
  /** Old ingredient's display name per locale (the regex target). */
  oldName: ReadonlyMap<Locale, string>;
  /** New ingredient's display name per locale (the substitute). */
  newName: ReadonlyMap<Locale, string>;
}

/**
 * Variant-title templates, one per locale. Adding a new locale to the
 * `Locale` enum surfaces here as a TS error so the template can't be
 * forgotten.
 */
const VARIANT_TITLE: Record<Locale, (base: string, replacement: string) => string> = {
  en: (base, replacement) => `${base} (with ${replacement})`,
  pl: (base, replacement) => `${base} (z ${replacement})`,
};

/**
 * Rewrite callback. Returns the new {description, steps} pair — or `null`
 * when the AI is unavailable / the validator rejected its output. The text
 * Mode A made then stands.
 */
export type ModeBRewriter = (
  locale: Locale,
  source: { description: string; steps: string[]; oldName: string; newName: string },
) => Promise<{ description: string; steps: string[] } | null>;

export interface SwapRewriteBInput extends SwapRewriteInput {
  /** The language the model rewords: the one the user reads the recipe in. */
  locale: Locale;
  rewrite: ModeBRewriter;
}

/**
 * Mode B: every language gets the Mode A text, and a model then rewords one
 * of them. One language means one call: the recipe is read by the one user
 * who made it, in the language they asked in, and a call for every language
 * a recipe is written in would take that many from their allowance.
 *
 * The title always comes from the template, which is more consistent than a
 * model's rewording of four words.
 *
 * The validator that decides "is this AI output safe to splice in?" lives
 * inside the caller's `rewrite` implementation — it has access to the prompt
 * + the catalogue + the original sentences, which the splicer doesn't.
 */
export async function rewriteSwapModeB(
  input: SwapRewriteBInput,
): Promise<Map<Locale, RecipeLocaleSlice>> {
  const out = rewriteSwapModeA(input);
  const slice = input.source.get(input.locale);
  const oldName = input.oldName.get(input.locale);
  const newName = input.newName.get(input.locale);
  if (!slice || !oldName || !newName) return out;

  const reworded = await input.rewrite(input.locale, {
    description: slice.description,
    steps: slice.steps,
    oldName,
    newName,
  });
  if (reworded) {
    out.set(input.locale, {
      title: VARIANT_TITLE[input.locale](slice.title, newName),
      description: reworded.description,
      steps: reworded.steps,
    });
  }
  return out;
}

/**
 * Validate an AI-rewritten {description, steps} against the source. Returns
 * `true` when the output is safe to splice into the variant. Rejection rules
 * mirror the prompt-validator pattern from translation work:
 *
 *  - Step count must match (AI must not add or drop steps).
 *  - No new digit sequences (no invented calories, weights, times).
 *  - Output mentions the new ingredient at least once and does not mention
 *    the old ingredient by name.
 *  - Total character length stays within [0.5×, 2×] of the source — catches
 *    dramatic over/under-generation.
 *
 * The caller is responsible for passing the AI's response through this gate
 * before returning it from the `ModeBRewriter`. We export it so both the
 * production wiring and tests use one implementation.
 */
export function validateModeBOutput(
  source: { description: string; steps: string[]; oldName: string; newName: string },
  candidate: { description: string; steps: string[] },
): boolean {
  if (!Array.isArray(candidate.steps) || candidate.steps.length !== source.steps.length) {
    return false;
  }
  if (typeof candidate.description !== 'string' || candidate.description.length === 0) {
    return false;
  }
  for (const step of candidate.steps) {
    if (typeof step !== 'string' || step.trim().length === 0) return false;
  }

  const srcDigits = extractDigitSequences(source.description, source.steps);
  const outDigits = extractDigitSequences(candidate.description, candidate.steps);
  for (const d of outDigits) {
    if (!srcDigits.has(d)) return false;
  }

  const newRegex = wordBoundaryRegex(source.newName);
  const oldRegex = wordBoundaryRegex(source.oldName);
  const joined = candidate.description + ' ' + candidate.steps.join(' ');
  if (!newRegex.test(joined)) return false;
  // Reject if oldName still appears verbatim — the AI failed to substitute.
  // Reset regex lastIndex (global flag preserves state across .test).
  oldRegex.lastIndex = 0;
  if (oldRegex.test(joined)) return false;

  const srcLen = source.description.length + source.steps.join(' ').length;
  const outLen = candidate.description.length + candidate.steps.join(' ').length;
  if (outLen < srcLen * 0.5 || outLen > srcLen * 2.0) return false;

  return true;
}

function extractDigitSequences(description: string, steps: string[]): Set<string> {
  const all = description + ' ' + steps.join(' ');
  return new Set(all.match(/\d+(?:[.,]\d+)?/g) ?? []);
}

/**
 * The edges of a word, for any alphabet. `\b` knows only ASCII letters, so a
 * name that starts or ends with a Polish letter ("brokuł", "żurawina") would
 * have no edge next to a space and never match.
 */
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';

const escapeForRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordBoundaryRegex(name: string): RegExp {
  return new RegExp(`${WORD_START}${escapeForRegex(name)}${WORD_END}`, 'giu');
}

/**
 * Mode A: localized string substitution.
 *
 * For each locale present on the source recipe:
 *  - `description`: replace every occurrence of `oldName` with `newName`.
 *  - `steps[]`: same per element.
 *  - `title`: append the variantTitle template using the new replacement;
 *    the base title is the source's *current* title in that locale (which
 *    may already be a variant — that's fine, we just keep stacking).
 *
 * The replace is case-insensitive on the first-letter only (`Chicken` and
 * `chicken` both match), preserving the original word's casing on the
 * substitution. Anything fancier (inflected forms, declensions in Polish)
 * is deferred to Mode B.
 */
export function rewriteSwapModeA(input: SwapRewriteInput): Map<Locale, RecipeLocaleSlice> {
  const out = new Map<Locale, RecipeLocaleSlice>();
  for (const [locale, slice] of input.source) {
    const oldName = input.oldName.get(locale);
    const newName = input.newName.get(locale);
    if (!oldName || !newName) {
      // Without a name for the substitute there is nothing true to say about
      // it: the text stays as it is. The title in particular never gets the
      // name of the ingredient that was taken out.
      out.set(locale, {
        title: newName ? applyTitleTemplate(locale, slice.title, newName) : slice.title,
        description: slice.description,
        steps: slice.steps,
      });
      continue;
    }
    out.set(locale, {
      title: applyTitleTemplate(locale, slice.title, newName),
      description: substituteCaseAware(slice.description, oldName, newName),
      steps: slice.steps.map((s) => substituteCaseAware(s, oldName, newName)),
    });
  }
  return out;
}

function applyTitleTemplate(locale: Locale, base: string, replacement: string): string {
  return VARIANT_TITLE[locale](base, replacement);
}

/**
 * Case-aware replace on the first letter. Preserves the input casing of the
 * matched fragment so "Chicken" → "Tofu" and "chicken" → "tofu" both feel
 * natural; everything past the first letter is left as-typed in `newName`.
 *
 * Uses a regex so we replace every occurrence in one pass. Escapes regex
 * metacharacters in `oldName` defensively (ingredient names usually don't
 * carry any, but USDA descriptions sometimes do).
 */
export function substituteCaseAware(
  text: string,
  oldName: string,
  newName: string,
): string {
  if (!oldName) return text;
  const escaped = escapeForRegex(oldName);
  // Two-pass substitution. The first pass uses a strict word boundary so
  // clean nominative cases (most English) substitute cleanly. The second
  // pass kicks in only when the first found nothing — it allows a trailing
  // inflected suffix on the same word so Polish forms like "kurczakiem" /
  // "kurczaka" still get swapped (matched and replaced with `newName`,
  // dropping the inflection). Length-gated to ≥4 characters so short names
  // like "egg" don't overmatch "eggplant" without the strict pass having
  // already done its work.
  const strict = new RegExp(`${WORD_START}${escaped}${WORD_END}`, 'giu');
  if (strict.test(text)) {
    strict.lastIndex = 0;
    return text.replace(strict, (match) => preserveLeadingCase(match, newName));
  }
  if (oldName.length < 4) return text;
  const stem = new RegExp(`${WORD_START}${escaped}[\\p{L}\\p{N}_']*${WORD_END}`, 'giu');
  return text.replace(stem, (match) => preserveLeadingCase(match, newName));
}

/**
 * Preserve the first-letter casing of `match` when emitting `replacement`.
 * "Chicken" → "Tofu", "chicken" → "tofu". Empty matches return `replacement`
 * verbatim.
 */
function preserveLeadingCase(match: string, replacement: string): string {
  if (match.length === 0 || replacement.length === 0) return replacement;
  const upper = match[0]! === match[0]!.toUpperCase();
  return upper
    ? replacement[0]!.toUpperCase() + replacement.slice(1)
    : replacement[0]!.toLowerCase() + replacement.slice(1);
}
