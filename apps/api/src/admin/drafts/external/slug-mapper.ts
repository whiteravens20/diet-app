// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Which ingredient of the catalogue a name in somebody else's recipe means.
 *
 * A name is matched in full or not at all. It is first brought to a plain
 * form (lower case, one of a thing, without the words that say how it is cut
 * or how big it is), then looked up among the aliases the operator keeps and
 * among the names the catalogue has for its ingredients, brought to the same
 * form. Nothing is matched by resemblance: "dried apricots" that became
 * "apricots" would be a recipe with the wrong figures, and a person who
 * reviews a draft sees the figures, not the guess behind them.
 */

/** An ingredient of the catalogue, by what it can be called in English. */
export interface KnownIngredient {
  slug: string;
  names: readonly string[];
}

export type SlugMapper = (name: string) => string | null;

/**
 * Words that say how a thing is cut, how big it is or that it is fresh.
 * None of them changes what a hundred grams of it hold. Words that do
 * (dried, ground, smoked, canned, cooked, whole as in whole milk) are no part
 * of this list, and stay in the name.
 */
const HOW_IT_COMES = new Set([
  'chopped', 'diced', 'sliced', 'minced', 'grated', 'shredded', 'peeled', 'crushed', 'halved', 'quartered', 'cubed', 'trimmed', 'rinsed', 'washed', 'beaten',
  'finely', 'roughly', 'coarsely', 'thinly', 'thickly', 'freshly', 'large', 'small', 'medium', 'fresh', 'ripe',
]);

/** One of a thing: `tomatoes` → `tomato`, `berries` → `berry`, `eggs` → `egg`. */
function one(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('oes')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

/** The plain form two names are compared in. */
export function plainName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word !== '' && !HOW_IT_COMES.has(word))
    .map(one)
    .join(' ');
}

/**
 * A mapper over the catalogue's ingredients and the operator's aliases
 * (`{ "all-purpose flour": "wheat-flour" }`). An alias wins over the
 * catalogue's own names; one that points at a slug the catalogue does not
 * have is no alias. A plain form that two ingredients share names neither.
 */
export function slugMapper(ingredients: readonly KnownIngredient[], aliases: Readonly<Record<string, string>>): SlugMapper {
  const known = new Set(ingredients.map((ingredient) => ingredient.slug));
  const byName = new Map<string, string | null>();
  for (const ingredient of ingredients) {
    for (const name of [...ingredient.names, ingredient.slug.replaceAll('-', ' ')]) {
      const plain = plainName(name);
      if (plain === '') continue;
      const held = byName.get(plain);
      byName.set(plain, held === undefined || held === ingredient.slug ? ingredient.slug : null);
    }
  }
  const byAlias = new Map<string, string>();
  for (const [name, slug] of Object.entries(aliases)) if (known.has(slug)) byAlias.set(plainName(name), slug);

  return (name) => {
    const plain = plainName(name);
    return byAlias.get(plain) ?? byName.get(plain) ?? null;
  };
}
