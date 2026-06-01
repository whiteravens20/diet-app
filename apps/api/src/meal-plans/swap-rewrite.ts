import type { Locale } from '@diet-app/shared';

/**
 * Per-locale clone rewriter for `applyIngredientSwap`. The plan in §I.5 gives
 * us two modes:
 *
 *  - **Mode A (default, no-AI):** localized string substitution. Replace the
 *    OLD ingredient's translated name with the NEW one's translated name in
 *    each translation row, then rewrite the title via the locale-specific
 *    `variantTitle` template. Free, deterministic, works without a provider.
 *  - **Mode B:** sentence-level AI rewrite — only sentences mentioning the
 *    old ingredient get sent to the model. Implemented in Phase I.5 mode B.
 *
 * This file owns Mode A. The variantTitle template is hardcoded per locale on
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
 * Per-locale rewrite callback. Returns the new {description, steps} pair —
 * or `null` when the AI is unavailable / the validator rejected its output.
 * The caller falls back to Mode A for that locale on null.
 */
export type ModeBRewriter = (
  locale: Locale,
  source: { description: string; steps: string[]; oldName: string; newName: string },
) => Promise<{ description: string; steps: string[] } | null>;

export interface SwapRewriteBInput extends SwapRewriteInput {
  rewrite: ModeBRewriter;
}

/**
 * Mode B: AI-driven per-locale rewrite. For each locale present on the source:
 *
 *  - Compute the Mode A title (templated suffix — cheaper and more consistent
 *    than asking the AI to rewrite a 4-word title).
 *  - If `oldName`/`newName` are absent for that locale, fall back to Mode A.
 *  - Otherwise call `rewrite(locale, …)`. On a non-null return, use it; on
 *    null, fall back to Mode A for that locale so the user still gets a
 *    coherent result.
 *
 * The validator that decides "is this AI output safe to splice in?" lives
 * inside the caller's `rewrite` implementation — it has access to the prompt
 * + the catalogue + the original sentences, which the splicer doesn't. The
 * splicer's only job is the per-locale orchestration.
 */
export async function rewriteSwapModeB(
  input: SwapRewriteBInput,
): Promise<Map<Locale, RecipeLocaleSlice>> {
  const out = new Map<Locale, RecipeLocaleSlice>();
  for (const [locale, slice] of input.source) {
    const oldName = input.oldName.get(locale);
    const newName = input.newName.get(locale);
    if (!oldName || !newName) {
      // Fall through to Mode A for this locale; the title still gets the
      // template treatment.
      const fallback = rewriteSwapModeA({
        source: new Map([[locale, slice]]),
        oldName: input.oldName,
        newName: input.newName,
      });
      const f = fallback.get(locale);
      if (f) out.set(locale, f);
      continue;
    }
    const aiOut = await input.rewrite(locale, {
      description: slice.description,
      steps: slice.steps,
      oldName,
      newName,
    });
    if (aiOut) {
      out.set(locale, {
        title: VARIANT_TITLE[locale](slice.title, newName),
        description: aiOut.description,
        steps: aiOut.steps,
      });
    } else {
      // Validator rejected the AI output (or AI was unavailable). Fall back
      // to Mode A for this locale only — other locales' AI rewrites stand.
      const fallback = rewriteSwapModeA({
        source: new Map([[locale, slice]]),
        oldName: new Map([[locale, oldName]]),
        newName: new Map([[locale, newName]]),
      });
      const f = fallback.get(locale);
      if (f) out.set(locale, f);
    }
  }
  return out;
}

/**
 * Validate an AI-rewritten {description, steps} against the source. Returns
 * `true` when the output is safe to splice into the variant. Rejection rules
 * mirror the prompt-validator pattern from F14 translation work:
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

function wordBoundaryRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'gi');
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
      // No translation for this locale on either ingredient — leave the slice
      // untouched and let the title-template still wrap it so the user sees
      // *something* changed. Better than dropping the locale.
      out.set(locale, {
        title: applyTitleTemplate(locale, slice.title, newName ?? oldName ?? ''),
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
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Two-pass substitution. The first pass uses a strict word boundary so
  // clean nominative cases (most English) substitute cleanly. The second
  // pass kicks in only when the first found nothing — it allows a trailing
  // inflected suffix on the same word so Polish forms like "kurczakiem" /
  // "kurczaka" still get swapped (matched and replaced with `newName`,
  // dropping the inflection). Length-gated to ≥4 characters so short names
  // like "egg" don't overmatch "eggplant" without the strict pass having
  // already done its work.
  const strict = new RegExp(`\\b${escaped}\\b`, 'gi');
  if (strict.test(text)) {
    strict.lastIndex = 0;
    return text.replace(strict, (match) => preserveLeadingCase(match, newName));
  }
  if (oldName.length < 4) return text;
  const stem = new RegExp(`\\b${escaped}[\\w']*\\b`, 'gi');
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
