// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What a recipe a model wrote is held to beyond the rules of every recipe
 * (`recipe-rules.ts`), wherever the model wrote it: in a batch of the
 * administrator's panel and in a draft a user asked for. Each check is one a
 * model fails and a person writing by hand does not need.
 */

/**
 * What the title of a recipe a model wrote may not say, nor the slug made of
 * it: a diet, which stops being true when the figures of an ingredient move;
 * a complexity band; praise. The diets a recipe suits are worked out and shown
 * beside it.
 */
const TITLE_SAYS_MORE =
  /\b(keto|ketogenic|low[- ]carb|high[- ]protein|vegan|vegetarian|simple|easy|quick|healthy)\b/i;

/** Whether a title (or the slug made of it) names a diet, a band or praise. */
export function titleSaysMore(title: string): boolean {
  return TITLE_SAYS_MORE.test(title);
}

/** The meals a main dish is eaten at. Every other meal is a small one. */
export const MAIN_MEALS: ReadonlySet<string> = new Set(['lunch', 'dinner']);

/**
 * Whether a recipe says it is both a main dish and a small one. A main dish
 * that also says it is a snack or a breakfast was stretched to fit the meal
 * that was asked for, and a plan would serve half a dinner between meals.
 */
export function mealsOfTwoKinds(mealTypes: readonly string[]): boolean {
  return (
    mealTypes.some((meal) => MAIN_MEALS.has(meal)) &&
    mealTypes.some((meal) => !MAIN_MEALS.has(meal))
  );
}

/**
 * The number of steps of each language, said as "en 4, pl 3", when the
 * languages differ in it, or null. Each language tells the same dish step by
 * step: a language with fewer steps than another lost some on the way.
 */
export function stepsDiffer(steps: Readonly<Record<string, readonly string[]>>): string | null {
  const lists = Object.entries(steps);
  if (new Set(lists.map(([, list]) => list.length)).size <= 1) return null;
  return lists.map(([locale, list]) => `${locale} ${list.length}`).join(', ');
}

/** An ingredient the catalogue calls by one word, and how that word is found in a text, one of it or several. */
export interface NamedByOneWord {
  slug: string;
  /** The word without its plural ending: what the name of an ingredient that stands in for it holds. */
  stem: string;
  found: RegExp;
}

/**
 * The ingredients a text can be held to: those whose English name is one
 * word ("Salt", "Lemon", "Mushrooms"). A name of several words ("Black
 * pepper", "Olive oil") is left out: its last word alone ("pepper", "oil")
 * names other things too.
 */
export function namedByOneWord(names: readonly { slug: string; name: string }[]): NamedByOneWord[] {
  return names
    .map(({ slug, name }) => ({ slug, word: name.trim().toLowerCase() }))
    .filter(({ word }) => /^[a-z]{3,}$/.test(word))
    .map(({ slug, word }) => {
      const [stem, endings] = word.endsWith('ies')
        ? [word.slice(0, -3), '(?:y|ies)']
        : word.endsWith('s')
          ? [word.slice(0, -1), 's?']
          : [word, '(?:s|es)?'];
      return { slug, stem, found: new RegExp(`\\b${stem}${endings}\\b`) };
    });
}

/**
 * The first ingredient of the catalogue that the text names and the list
 * does not hold, or null. An ingredient of the list whose own name holds the
 * word answers for it: peanut butter for "butter", canned tomatoes for
 * "tomato".
 */
export function namedButNotListed(
  text: string,
  listed: readonly string[],
  named: readonly NamedByOneWord[],
  nameOf: ReadonlyMap<string, string>,
): string | null {
  const lower = text.toLowerCase();
  const have = listed.map((slug) => (nameOf.get(slug) ?? slug).toLowerCase());
  for (const { slug, stem, found } of named) {
    if (listed.includes(slug) || !found.test(lower)) continue;
    if (!have.some((name) => name.includes(stem))) return slug;
  }
  return null;
}

/** Words of an ingredient's name that say what it is like, not what it is: "white" rice, a "large" egg. */
const DESCRIBING = new Set([
  'large',
  'small',
  'whole',
  'grain',
  'white',
  'black',
  'red',
  'green',
  'yellow',
  'brown',
  'sweet',
  'sour',
  'heavy',
  'light',
  'smoked',
  'canned',
  'rolled',
  'dried',
  'fresh',
  'frozen',
  'ground',
  'extra',
  'virgin',
  'raw',
  'cooked',
  'plain',
  'wild',
  'baby',
  'fillet',
  'breast',
  'thigh',
]);

/**
 * The first ingredient of the list that no step uses, or null. An ingredient
 * is used where a step names a word of its English name ("the oil" for olive
 * oil, "the eggs" for a large egg); a word that only says what it is like
 * ("white", "large") uses nothing. An ingredient without a name is passed over.
 */
export function listedButNotUsed(
  steps: string,
  listed: readonly string[],
  nameOf: ReadonlyMap<string, string>,
): string | null {
  const lower = steps.toLowerCase();
  for (const slug of listed) {
    const words = (nameOf.get(slug) ?? '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 3 && !DESCRIBING.has(word));
    if (words.length === 0) continue;
    const used = words.some((word) =>
      new RegExp(
        `\\b${word.endsWith('ies') ? word.slice(0, -3) : word.endsWith('s') ? word.slice(0, -1) : word}`,
      ).test(lower),
    );
    if (!used) return slug;
  }
  return null;
}
