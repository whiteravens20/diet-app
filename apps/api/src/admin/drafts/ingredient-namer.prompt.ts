/**
 * Ingredient-name namer prompt.
 *
 * Asks the AI to rewrite a raw USDA FoodData Central description into a
 * friendly culinary name for every locale in the spec. The result is stored
 * in `IngredientNameDraft.suggestions` as a JSON column, never written
 * directly to `Ingredient` — see ADR-0008.
 *
 * Locale-generic: the prompt is rendered against `targetLocales` from the
 * generation spec. Each locale loads its own optional `few-shot/ingredient-namer.<locale>.json`
 * — a few-shot file is recommended for quality but not required.
 *
 * Prompt-version tag is exported so drafts can be filtered by the prompt
 * iteration that produced them — useful when we tighten the prompt and want
 * to regenerate only stale drafts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from '@diet-app/shared';

export const INGREDIENT_NAMER_PROMPT_VERSION = 'ingredient-namer.v1';

const FEW_SHOT_DIR = join(__dirname, 'few-shot');

const LOCALE_LABEL: Record<string, string> = {
  pl: 'Polish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  en: 'English',
};

interface FewShotPair {
  source: string;
  translation: string;
}

function loadFewShot(locale: string): FewShotPair[] {
  const path = join(FEW_SHOT_DIR, `ingredient-namer.${locale}.json`);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FewShotPair[];
  } catch {
    return [];
  }
}

function renderFewShot(locale: string, pairs: FewShotPair[]): string {
  if (pairs.length === 0) return '';
  const label = LOCALE_LABEL[locale] ?? locale;
  const lines = pairs.map((p) => `- "${p.source}" → "${p.translation}"`).join('\n');
  return `Examples — ${label} (${locale}):\n${lines}\n\n`;
}

export interface IngredientNamerPromptInput {
  targetLocales: Locale[];
  /** Raw FDC descriptions keyed by ingredient slug — what the AI rewrites. */
  source: Record<string, string>;
}

export function buildIngredientNamerPrompt({
  targetLocales,
  source,
}: IngredientNamerPromptInput): string {
  const localeList = targetLocales
    .map((l) => `${LOCALE_LABEL[l] ?? l} (${l})`)
    .join(', ');
  const fewShot = targetLocales.map((l) => renderFewShot(l, loadFewShot(l))).join('');
  const shapeExample = renderShapeExample(targetLocales);
  return `You are a culinary editor for a self-hosted diet and meal-planning
application. You will rewrite raw USDA FoodData Central ingredient descriptions
into short, friendly names a home cook would actually recognise.

Target locales: ${localeList}.

You will receive a JSON object whose values are raw FDC descriptions in
English. For every key in the input, return a value of the shape:

  ${shapeExample}

Return ONLY the JSON object — no prose, no explanations, no markdown fences.

Rules — follow strictly:
1. The friendly name is the kind of label a cookbook or grocery shelf would
   use. Drop bureaucratic qualifiers ("separable lean only", "trimmed to 0\\"
   fat", "select, cooked, roasted", "raw"). Keep only what a cook needs.
2. Keep the most informative cut/part word: "Beef, loin, tenderloin roast,
   separable lean only, …" → "Beef tenderloin", not just "Beef".
3. ${targetLocales.includes('en' as Locale) ? 'For English, use the everyday culinary term.' : 'English (en) is the canonical source — do not include en in your output unless asked.'}
4. For non-English locales, use the most common everyday culinary term in
   that language, not a literal word-for-word translation. Translate the
   meaning, then phrase it the way a native speaker would write it on a
   shopping list.
5. NEVER add quantities, calories, weights, cooking times, or any numbers
   that are not in the source. Translate only short free-form text.
6. If the source contains a brand name, Latin name, or unit symbol (g, ml,
   kcal, °C, …) pass it through unchanged in every locale.
7. Optional \`storageHint\` may be added when the source description implies
   one (e.g. "frozen, wild caught" → can suggest "Keep frozen"). If you
   would just be padding, omit \`storageHint\` entirely — never invent.
8. If you cannot confidently rewrite a row, return the original FDC
   description verbatim as the name for every locale. Do NOT guess.
9. Output literal characters in JSON values. Never HTML-escape
   (no \`&amp;\`, \`&quot;\`, \`&lt;\`, etc.).

${fewShot}Rewrite this object:
${JSON.stringify(source)}`;
}

/** Render the locale-keyed shape for the prompt's "shape" line. */
function renderShapeExample(locales: Locale[]): string {
  const nameKeys = locales.map((l) => `"${l}": "<friendly name in ${l}>"`).join(', ');
  return `{ "name": { ${nameKeys} }, "storageHint"?: { ${locales.map((l) => `"${l}": "<hint in ${l}>"`).join(', ')} } }`;
}
