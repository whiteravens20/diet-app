/**
 * F14 auto-translate post-validator.
 *
 * The runner sends short, JSON-formatted batches to an LLM. The LLM can
 * misbehave in many ways — markdown fences, "Note:" prefaces, added quotes,
 * inventing numbers, refusing to translate, returning mixed-language output.
 * Garbage that lands in the translation tables is hard to spot until a user
 * sees it, so every response runs through these checks BEFORE any DB write.
 *
 * Honest names for the failure modes are encoded as the `reason` field so
 * tests can assert on a specific rejection type instead of just the boolean.
 */

export type ValidationReason =
  | 'malformed-json'
  | 'missing-keys'
  | 'extra-keys'
  | 'llm-yap'
  | 'added-quotes'
  | 'identical-to-source'
  | 'invented-digits'
  | 'length-blowup'
  | 'untranslated';

export interface ValidationResult {
  ok: boolean;
  /** When ok=false, identifies which check failed. */
  reason?: ValidationReason;
  /** When ok=false, the key that triggered the failure. */
  key?: string;
  /** Sanitised translations when ok=true. */
  translations?: Record<string, string>;
}

const LLM_YAP_PATTERNS = [
  /\bnote\s*:/i,
  /\btranslation\s*:/i,
  /\bas an ai\b/i,
  /\bi cannot\b/i,
  /\bsorry\b/i,
  /\bi apologi/i,
  /^here (is|are)\b/i,
];

/** English stopwords that should not appear in a non-English translation
 *  output (cheap "did the model actually translate?" heuristic). */
const ENGLISH_STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'of',
  'in',
  'on',
  'to',
  'for',
  'from',
  'a',
  'an',
  'is',
  'are',
]);

/** Source values that always come through unchanged (units, brands, numerics).
 *  When the translation equals one of these we don't treat that as a failure. */
const PASSTHROUGH_RE = /^(\d[\d.,]*|g|ml|kg|l|°C|°F|kcal|mg|µg|μg)$/i;

export interface ValidateOptions {
  /** Source object handed to the model — used for identical-to-source and
   *  digit-invention checks. */
  source: Record<string, string>;
  /** ISO 639-1 target locale (e.g. 'pl', 'de'). Drives the stopword set. */
  targetLocale: string;
  /** Raw model output. Often comes wrapped in markdown fences or with
   *  leading prose; this function strips that and re-parses. */
  rawOutput: string;
}

/** Strip a leading markdown fence and any prose preceding the first `{`. */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  // Markdown fence: ```json\n{...}\n``` or ```\n{...}\n```
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]+?)\n\s*```/i);
  if (fenced) return fenced[1].trim();
  // No fence — look for the first `{` and matching last `}`.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function validate(opts: ValidateOptions): ValidationResult {
  const { source, targetLocale, rawOutput } = opts;
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

  // Key-set parity: exact match (no extras, no missing).
  for (const k of sourceKeys) {
    if (!(k in out)) return { ok: false, reason: 'missing-keys', key: k };
  }
  for (const k of outKeys) {
    if (!(k in source)) return { ok: false, reason: 'extra-keys', key: k };
  }

  const sanitised: Record<string, string> = {};
  for (const key of sourceKeys) {
    const value = out[key];
    if (typeof value !== 'string') {
      return { ok: false, reason: 'missing-keys', key };
    }
    const trimmed = value.trim();
    const srcVal = source[key];

    // LLM yapping prefixes / chatty refusals.
    if (LLM_YAP_PATTERNS.some((re) => re.test(trimmed))) {
      return { ok: false, reason: 'llm-yap', key };
    }

    // Added quote-wrapping that wasn't in the source.
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"') && !srcVal.startsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'") && !srcVal.startsWith("'"))
    ) {
      return { ok: false, reason: 'added-quotes', key };
    }

    // Source-identical passthrough is fine only when the source is itself
    // a non-translatable token (unit symbol, number, brand). Otherwise the
    // model didn't translate.
    if (trimmed === srcVal && !PASSTHROUGH_RE.test(srcVal)) {
      return { ok: false, reason: 'identical-to-source', key };
    }

    // Invented digits — catches "Chicken breast" → "Pierś z kurczaka 300 kcal".
    // Critical for the "nutrition is never invented" rule.
    const srcDigits = new Set(srcVal.match(/\d/g) ?? []);
    const outDigits = trimmed.match(/\d/g) ?? [];
    for (const d of outDigits) {
      if (!srcDigits.has(d)) {
        return { ok: false, reason: 'invented-digits', key };
      }
    }

    // Length blow-up (or shrink). Catches dramatic over/under-generation.
    if (srcVal.length > 0) {
      const ratio = trimmed.length / srcVal.length;
      if (ratio < 0.4 || ratio > 3.0) {
        return { ok: false, reason: 'length-blowup', key };
      }
    }

    // English stopword density check (target is not English).
    if (targetLocale !== 'en') {
      const tokens = trimmed
        .toLowerCase()
        .replace(/[^a-zà-ÿąćęłńóśźżäöüß]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      const englishHits = tokens.filter((tok) => ENGLISH_STOPWORDS.has(tok)).length;
      if (englishHits >= 2) {
        return { ok: false, reason: 'untranslated', key };
      }
    }

    sanitised[key] = trimmed;
  }

  return { ok: true, translations: sanitised };
}
