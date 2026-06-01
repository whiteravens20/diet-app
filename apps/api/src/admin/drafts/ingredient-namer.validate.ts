/**
 * Ingredient-name draft post-validator.
 *
 * Walks the AI's JSON response and rejects rows we wouldn't want a human
 * reviewer to even see — raw-FDC passthrough, invented digits, length blowup,
 * missing target locales, LLM yap. Every check has a stable
 * `reason` so the runner can log + the test suite can pin failure modes.
 *
 * Input shape per row:
 *   { "name": { "<locale>": "<friendly name>", … },
 *     "storageHint"?: { "<locale>": "<hint>", … } }
 *
 * The validator runs once per row inside `validateBatch`; per-batch shape
 * checks (JSON parsing, keyset parity) are also re-exported so the runner
 * can apply them up front.
 */
import { extractJson } from './ai-helpers.js';
import type { IngredientNameSuggestion } from '@diet-app/shared';

export type IngredientNamerValidationReason =
  | 'malformed-json'
  | 'missing-keys'
  | 'extra-keys'
  | 'name-not-object'
  | 'missing-locale'
  | 'empty-value'
  | 'raw-passthrough'
  | 'invented-digits'
  | 'length-blowup'
  | 'llm-yap';

export interface IngredientNamerValidationOk {
  ok: true;
  /** Sanitised suggestions keyed by the same slugs as the source. */
  suggestions: Record<string, IngredientNameSuggestion>;
}

export interface IngredientNamerValidationFail {
  ok: false;
  reason: IngredientNamerValidationReason;
  /** The slug that triggered the failure when applicable. */
  key?: string;
}

export type IngredientNamerValidationResult =
  | IngredientNamerValidationOk
  | IngredientNamerValidationFail;

const LLM_YAP_PATTERNS = [
  /\bnote\s*:/i,
  /\btranslation\s*:/i,
  /\bas an ai\b/i,
  /\bi cannot\b/i,
  /\bsorry\b/i,
  /\bi apologi/i,
  /^here (is|are)\b/i,
];

export interface ValidateIngredientNamerOptions {
  /** Source object handed to the model — slug → raw FDC description. */
  source: Record<string, string>;
  /** Locale codes the model was asked to fill. Every value object must
   *  cover all of these keys for `name`. */
  targetLocales: string[];
  /** Raw model output (may be wrapped in a markdown fence). */
  rawOutput: string;
}

export function validateIngredientNamer(
  opts: ValidateIngredientNamerOptions,
): IngredientNamerValidationResult {
  const { source, targetLocales, rawOutput } = opts;
  const sourceKeys = Object.keys(source);

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawOutput));
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'malformed-json' };
  }
  const out = parsed as Record<string, unknown>;
  const outKeys = Object.keys(out);

  for (const k of sourceKeys) {
    if (!(k in out)) return { ok: false, reason: 'missing-keys', key: k };
  }
  for (const k of outKeys) {
    if (!(k in source)) return { ok: false, reason: 'extra-keys', key: k };
  }

  const sanitised: Record<string, IngredientNameSuggestion> = {};
  for (const slug of sourceKeys) {
    const row = out[slug];
    if (typeof row !== 'object' || row === null) {
      return { ok: false, reason: 'name-not-object', key: slug };
    }
    const r = row as { name?: unknown; storageHint?: unknown };
    if (typeof r.name !== 'object' || r.name === null) {
      return { ok: false, reason: 'name-not-object', key: slug };
    }
    const nameMap = r.name as Record<string, unknown>;
    const cleanName: Record<string, string> = {};
    for (const locale of targetLocales) {
      const v = nameMap[locale];
      if (typeof v !== 'string') {
        return { ok: false, reason: 'missing-locale', key: `${slug}.name.${locale}` };
      }
      const trimmed = v.trim();
      if (trimmed.length === 0) {
        return { ok: false, reason: 'empty-value', key: `${slug}.name.${locale}` };
      }
      const rowCheck = checkValue({
        slug,
        locale,
        field: 'name',
        rawSource: source[slug],
        translated: trimmed,
      });
      if (!rowCheck.ok) return rowCheck;
      cleanName[locale] = trimmed;
    }

    let cleanStorage: Record<string, string> | undefined;
    if (r.storageHint !== undefined && r.storageHint !== null) {
      if (typeof r.storageHint !== 'object') {
        return { ok: false, reason: 'name-not-object', key: `${slug}.storageHint` };
      }
      const hintMap = r.storageHint as Record<string, unknown>;
      cleanStorage = {};
      for (const locale of targetLocales) {
        const v = hintMap[locale];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string') {
          return { ok: false, reason: 'missing-locale', key: `${slug}.storageHint.${locale}` };
        }
        const trimmed = v.trim();
        if (trimmed.length === 0) continue;
        const rowCheck = checkValue({
          slug,
          locale,
          field: 'storageHint',
          rawSource: source[slug],
          translated: trimmed,
        });
        if (!rowCheck.ok) return rowCheck;
        cleanStorage[locale] = trimmed;
      }
      // If the model returned an empty `storageHint` object, drop it.
      if (Object.keys(cleanStorage).length === 0) cleanStorage = undefined;
    }

    sanitised[slug] = {
      name: cleanName,
      ...(cleanStorage ? { storageHint: cleanStorage } : {}),
    };
  }

  return { ok: true, suggestions: sanitised };
}

interface CheckValueArgs {
  slug: string;
  locale: string;
  field: 'name' | 'storageHint';
  rawSource: string;
  translated: string;
}

function checkValue({
  slug,
  locale,
  field,
  rawSource,
  translated,
}: CheckValueArgs): { ok: true } | IngredientNamerValidationFail {
  if (LLM_YAP_PATTERNS.some((re) => re.test(translated))) {
    return { ok: false, reason: 'llm-yap', key: `${slug}.${field}.${locale}` };
  }

  // The name field is the most common failure: AI just copies the raw FDC
  // description verbatim. That defeats the whole point.
  if (field === 'name' && translated === rawSource.trim()) {
    return { ok: false, reason: 'raw-passthrough', key: `${slug}.${field}.${locale}` };
  }

  // Invented digits — every digit in the translation must have come from the
  // source. Catches "Beef tenderloin 300 kcal".
  const srcDigits = new Set(rawSource.match(/\d/g) ?? []);
  const outDigits = translated.match(/\d/g) ?? [];
  for (const d of outDigits) {
    if (!srcDigits.has(d)) {
      return { ok: false, reason: 'invented-digits', key: `${slug}.${field}.${locale}` };
    }
  }

  // Length: friendly names should *shrink* the raw FDC description, not
  // explode. We allow modest growth (e.g. "Pears, raw, bartlett" →
  // "Gruszki bartlett" is similar length) but anything > 1.8× is the AI
  // padding. Floor of 0.1× catches truncation to a single letter.
  if (field === 'name' && rawSource.length > 0) {
    const ratio = translated.length / rawSource.length;
    if (ratio < 0.1 || ratio > 1.8) {
      return { ok: false, reason: 'length-blowup', key: `${slug}.${field}.${locale}` };
    }
  }

  return { ok: true };
}
