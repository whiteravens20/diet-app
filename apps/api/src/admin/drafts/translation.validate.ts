// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What a model's translation is held to before a person sees it.
 *
 * A translation changes words and nothing else: it has the shape that was
 * asked for, as many steps as the English, no number the English does not
 * have, and it is a translation, not the English again and not a remark
 * about it. What passes is then held to the rules of every recipe
 * (`recipes/recipe-rules.ts`): plain text of a length.
 *
 * Each failure has a name of its own, for the log and for the tests.
 */
import { MAX_MODEL_REPLY_CHARS, readModelObject } from '../../ai/model-json.js';
import { checkRecipeText, type RecipeRule } from '../../recipes/recipe-rules.js';
import type { RecipeTextSource } from './translation.prompt.js';

export type TranslationProblem =
  | RecipeRule
  | 'malformed-json'
  | 'missing-keys'
  | 'extra-keys'
  | 'not-text'
  | 'empty-value'
  | 'step-count'
  | 'invented-number'
  | 'length-blowup'
  | 'llm-yap'
  | 'untranslated';

export type RecipeTranslationResult = { ok: true; text: RecipeTextSource } | { ok: false; reason: TranslationProblem; where: string };

const YAP = [/\bnote\s*:/i, /\btranslation\s*:/i, /\bas an ai\b/i, /\bi cannot\b/i, /\bi can't\b/i, /\bsorry\b/i, /^here (is|are)\b/i];

/** Words a sentence of a recipe in English is full of, and one in another language is not. */
const ENGLISH = new Set(['the', 'and', 'with', 'until', 'into', 'then', 'over', 'for', 'of', 'add', 'stir', 'cook', 'heat', 'serve', 'minutes', 'about', 'before']);

/** The numbers a text holds, a comma for a decimal point read as a point. */
const numbersOf = (text: string): string[] => (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((number) => number.replace(',', '.'));

const wordsOf = (text: string): string[] => text.toLowerCase().match(/\p{L}+/gu) ?? [];

/** Whether `text` reads as English: three or more of its words, and a third of them, are English words a recipe is full of. */
function readsAsEnglish(text: string): boolean {
  const words = wordsOf(text);
  const english = words.filter((word) => ENGLISH.has(word)).length;
  return english >= 3 && english * 3 >= words.length;
}

/** What is wrong with one translated text against the English it was made from, if anything. */
function problemOf(translated: string, english: string, allowed: ReadonlySet<string>, locale: string, sentence: boolean): TranslationProblem | null {
  if (translated.trim() === '') return 'empty-value';
  if (YAP.some((pattern) => pattern.test(translated))) return 'llm-yap';
  if (numbersOf(translated).some((number) => !allowed.has(number))) return 'invented-number';
  if (english.length >= 12) {
    const ratio = translated.length / english.length;
    if (ratio < 0.3 || ratio > 3) return 'length-blowup';
  }
  if (sentence && locale !== 'en') {
    const same = translated.trim().toLowerCase() === english.trim().toLowerCase() && wordsOf(english).length >= 3;
    if (same || readsAsEnglish(translated)) return 'untranslated';
  }
  return null;
}

/** The text of one recipe in `locale`, as a model answered, or why the answer is no use. */
export function validateRecipeTranslation(options: { source: RecipeTextSource; locale: string; rawOutput: string }): RecipeTranslationResult {
  const { source, locale } = options;
  const reply = readModelObject(options.rawOutput, MAX_MODEL_REPLY_CHARS);
  if (!reply.ok) return { ok: false, reason: 'malformed-json', where: '' };
  const answer = reply.value;

  for (const key of ['title', 'description', 'steps']) if (!(key in answer)) return { ok: false, reason: 'missing-keys', where: key };
  for (const key of Object.keys(answer)) if (!['title', 'description', 'steps'].includes(key)) return { ok: false, reason: 'extra-keys', where: key };
  const { title, description, steps } = answer;
  if (typeof title !== 'string') return { ok: false, reason: 'not-text', where: 'title' };
  if (typeof description !== 'string') return { ok: false, reason: 'not-text', where: 'description' };
  if (!Array.isArray(steps) || steps.some((step) => typeof step !== 'string')) return { ok: false, reason: 'not-text', where: 'steps' };
  if (steps.length !== source.steps.length) return { ok: false, reason: 'step-count', where: 'steps' };

  // A number may move from one sentence of the recipe to another; it may not come from nowhere.
  const allowed = new Set(numbersOf([source.title, source.description, ...source.steps].join(' ')));
  const fields: [where: string, translated: string, english: string, sentence: boolean][] = [
    ['title', title, source.title, false],
    ['description', description, source.description, true],
    ...(steps as string[]).map((step, index): [string, string, string, boolean] => [`steps[${index}]`, step, source.steps[index]!, true]),
  ];
  for (const [where, translated, english, sentence] of fields) {
    const reason = problemOf(translated, english, allowed, locale, sentence);
    if (reason) return { ok: false, reason, where };
  }

  // What every recipe's text is held to, whoever wrote it.
  const checked = checkRecipeText({ titles: { [locale]: title }, descriptions: { [locale]: description }, steps: { [locale]: steps } }, [locale]);
  if (!checked.ok) return { ok: false, reason: checked.problems[0]!.rule, where: checked.problems[0]!.path };
  return { ok: true, text: { title: checked.text.titles[locale]!, description: checked.text.descriptions[locale] ?? '', steps: checked.text.steps[locale]! } };
}
