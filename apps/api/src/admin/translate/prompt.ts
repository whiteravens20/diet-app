/**
 * F14 auto-translate prompt builder.
 *
 * The prompt is version-pinned as a literal constant so changes are
 * reviewable in git. Per-locale `few-shot/<locale>.json` files contribute a
 * small corpus of exemplar translations to anchor terminology; empty for
 * locales we haven't curated few-shots for yet (the prompt still works, just
 * with lower quality).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolved relative to the compiled JS location — same trick as the seeder
// uses for its data dir. The api builds to CommonJS so __dirname is fine.
const FEW_SHOT_DIR = join(__dirname, 'few-shot');

/** Human-readable name per locale code, used as `{targetLanguage}` in the prompt. */
const LOCALE_LABEL: Record<string, string> = {
  pl: 'Polish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
};

interface FewShotPair {
  source: string;
  translation: string;
}

function loadFewShot(locale: string): FewShotPair[] {
  const path = join(FEW_SHOT_DIR, `${locale}.json`);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FewShotPair[];
  } catch {
    return [];
  }
}

function renderFewShot(pairs: FewShotPair[]): string {
  if (pairs.length === 0) return '';
  const lines = pairs.map((p) => `- "${p.source}" → "${p.translation}"`).join('\n');
  return `Examples (terminology anchors):\n${lines}\n\n`;
}

export interface BuildPromptInput {
  /** Target locale ISO code (`pl`, `de`, …). */
  targetLocale: string;
  /** Payload object to translate. Keys are stable identifiers; values are
   *  the source English text. */
  source: Record<string, string>;
}

export function buildPrompt({ targetLocale, source }: BuildPromptInput): string {
  const targetLanguage = LOCALE_LABEL[targetLocale] ?? targetLocale;
  const fewShot = renderFewShot(loadFewShot(targetLocale));
  return `You are a professional translator for a self-hosted diet and meal-planning
application. The domain is food, cooking, and nutrition.

Source language: English (en)
Target language: ${targetLanguage} (${targetLocale})

You will receive a JSON object whose values are short text fragments in
English. Translate every value into ${targetLanguage} and return a JSON
object with the SAME KEYS and translated values. Return ONLY the JSON
object — no prose, no explanations, no markdown fences, no quotes around
the JSON itself.

Rules — follow strictly:
1. Return ONLY translated text. Never add notes, comments, alternatives,
   pronunciations, or English originals in parentheses.
2. Do NOT translate: brand names, scientific Latin names, unit symbols
   (g, ml, kg, l, °C, kcal), numbers, or proper nouns. Pass them through
   unchanged.
3. Preserve formatting: line breaks, capitalisation style of the source
   (sentence case stays sentence case), and any list / step structure.
4. For cooking instructions, use the imperative form natural in
   ${targetLanguage}.
5. For ingredient and recipe names, use the most common everyday
   culinary term in ${targetLanguage}, not a literal word-for-word
   translation.
6. NEVER invent numbers, weights, calories, cooking times, or
   ingredients that are not in the source text.
7. If you cannot translate a fragment confidently, return the original
   English text for that key unchanged. Do NOT guess.
8. Output literal characters in JSON values. Never HTML-escape
   (no \`&amp;\`, \`&quot;\`, \`&lt;\`, etc.) — use the real \`&\`, \`"\`, \`<\`.
9. Translate the ampersand \`&\` as the target-language equivalent of "and"
   (e.g. Polish "i", German "und"). Do NOT carry the \`&\` symbol through to
   the translation.

${fewShot}Translate this object:
${JSON.stringify(source)}`;
}

/** Per-provider tuning knobs. Low temperature reduces creative reinterpretation
 *  and JSON-format drift. `interBatchDelayMs` is a baseline sleep between
 *  successful batches — non-zero for free-tier providers that throttle per
 *  minute (OpenRouter free = ~20 req/min, so 3500 ms keeps us safely under). */
export const PROVIDER_TUNING: Record<
  'openai' | 'anthropic' | 'openrouter' | 'ollama',
  { temperature: number; batchSize: number; interBatchDelayMs: number }
> = {
  openai: { temperature: 0.2, batchSize: 50, interBatchDelayMs: 0 },
  anthropic: { temperature: 0.2, batchSize: 50, interBatchDelayMs: 0 },
  // batchSize=20: gemini-2.5-flash-lite (and similar) reliably truncate
  // JSON output around 10-12k chars regardless of max_tokens. 50 keys ×
  // 2 fields blew past that on PL recipes; 20 keys × 2 fields stays
  // comfortably below. Smaller batches = more calls but ~zero waste on
  // re-rejected batches, net throughput is similar.
  openrouter: { temperature: 0.2, batchSize: 20, interBatchDelayMs: 3500 },
  ollama: { temperature: 0.2, batchSize: 20, interBatchDelayMs: 0 },
};
