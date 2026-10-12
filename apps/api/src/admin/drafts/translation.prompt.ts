// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What a model is asked when it writes a language a recipe lacks: the text of
 * that one recipe, from the English that people approved.
 *
 * Only free text goes to the model and only free text is asked back: a
 * title, a description, steps. Quantities, units, times and tags stay with
 * the engine and are never sent to be translated.
 *
 * Each language may have examples of its own in `few-shot/`: curated recipes
 * in English and in that language.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Stored with every draft the run writes, so that drafts of an earlier wording can be told apart. */
export const TRANSLATION_PROMPT_VERSION = 'translation.v1';

const FEW_SHOT_DIR = join(__dirname, 'few-shot');

const LANGUAGE: Record<string, string> = { pl: 'Polish', de: 'German', fr: 'French', es: 'Spanish', en: 'English' };
const languageOf = (locale: string): string => `${LANGUAGE[locale] ?? locale} (${locale})`;

/** The text of a recipe that is translated. */
export interface RecipeTextSource {
  title: string;
  description: string;
  steps: string[];
}

function readExamples<T>(file: string): T[] {
  const path = join(FEW_SHOT_DIR, file);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Up to two curated recipes in English and in `locale`, as the model is to answer. */
function recipeExamples(locale: string): string {
  type Curated = { title?: Record<string, string>; description?: Record<string, string>; steps?: Record<string, string[]> };
  const pairs = readExamples<Curated>(`recipe.${locale}.json`)
    .filter((recipe) => recipe.title?.en && recipe.title[locale] && recipe.steps?.en && recipe.steps[locale])
    .slice(0, 2)
    .map(
      (recipe) =>
        `English: ${JSON.stringify({ title: recipe.title!.en, description: recipe.description?.en ?? '', steps: recipe.steps!.en })}\n` +
        `${LANGUAGE[locale] ?? locale}: ${JSON.stringify({ title: recipe.title![locale], description: recipe.description?.[locale] ?? '', steps: recipe.steps![locale] })}`,
    );
  return pairs.length === 0 ? '' : `Examples:\n${pairs.join('\n\n')}\n\n`;
}

/** The prompt for the text of one recipe in `locale`. */
export function buildRecipeTranslationPrompt(locale: string, source: RecipeTextSource): string {
  return `You translate recipes for a diet and meal-planning application, from English into ${languageOf(locale)}.

You will receive a JSON object with the "title", the "description" and the "steps" of one recipe. Answer with a JSON object of the same shape in ${LANGUAGE[locale] ?? locale}: the same keys, and exactly as many steps, in the same order.

Return ONLY the JSON object: no prose, no explanations, no markdown fences.

Rules, to be followed strictly:
1. Write the way a cookbook in that language is written: natural sentences, the usual names of dishes and ingredients, not word for word.
2. Change no quantity, no number, no temperature and no time. Every number of the English text stays as it is, and no number is added.
3. Add nothing and leave nothing out: no step, no ingredient, no advice that the English does not give.
4. Units and symbols (g, ml, kcal, °C) stay as they are.
5. Write plain text: no markup, no HTML, no quotation marks around a whole value.

${recipeExamples(locale)}Translate this recipe:
${JSON.stringify({ title: source.title, description: source.description, steps: source.steps })}`;
}
