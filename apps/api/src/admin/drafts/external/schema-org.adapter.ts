// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Recipes written as schema.org `Recipe`: the shape a recipe has in the
 * JSON-LD of a web page and in the files many tools save. Nothing is fetched:
 * the document is one the operator has and hands over.
 *
 * A document is one recipe, a list of them, or a `@graph` that holds some
 * among other things. What is no recipe is passed over; a recipe is read as
 * far as it goes, and what it lacks is for the import to judge.
 */
import type { ExternalRecipe, ExternalRecipeSource } from './external-recipe.js';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** One thing or several, as a list. */
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const isRecipe = (node: Record<string, unknown>): boolean => listOf(node['@type']).includes('Recipe');

/** How deep lists within lists are looked into: a document of recipes is a list, or a graph of lists, and no deeper. */
const DEEPEST = 6;

/** The recipes of a document, wherever its lists and its graph put them. */
function recipeNodes(document: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > DEEPEST) return [];
  if (Array.isArray(document)) return document.flatMap((entry) => recipeNodes(entry, depth + 1));
  if (!isObject(document)) return [];
  if (isRecipe(document)) return [document];
  return Array.isArray(document['@graph']) ? document['@graph'].flatMap((entry) => recipeNodes(entry, depth + 1)) : [];
}

/** `PT1H30M` as 90; null for what is no such duration. Days and seconds are no times of a recipe. */
export function minutesOf(duration: unknown): number | null {
  const match = typeof duration === 'string' ? /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(duration.trim()) : null;
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

/** `4`, `"4"`, `"4 servings"` or `["4", "4 bowls"]` as 4; null where no number leads. */
function servingsOf(recipeYield: unknown): number | null {
  for (const entry of listOf(recipeYield)) {
    const match = typeof entry === 'number' ? [String(entry)] : typeof entry === 'string' ? /^\s*(\d+)/.exec(entry) : null;
    const servings = match ? Number(match[1] ?? match[0]) : Number.NaN;
    if (Number.isInteger(servings) && servings > 0) return servings;
  }
  return null;
}

/** The steps of `recipeInstructions`: a text of lines, a list of texts, of steps, or of sections of steps. */
function stepsOf(instructions: unknown, depth = 0): string[] {
  if (depth > DEEPEST) return [];
  if (typeof instructions === 'string') return instructions.split(/\r?\n+/).map(textOf).filter(Boolean);
  return listOf(instructions).flatMap((entry) => {
    if (typeof entry === 'string') return [textOf(entry)].filter(Boolean);
    if (!isObject(entry)) return [];
    if (Array.isArray(entry.itemListElement)) return stepsOf(entry.itemListElement, depth + 1);
    return [textOf(entry.text) || textOf(entry.name)].filter(Boolean);
  });
}

/** Words a recipe is filed under, from a text with commas or a list. */
const wordsOf = (value: unknown): string[] =>
  listOf(value)
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
    .map((word) => textOf(word).toLowerCase())
    .filter(Boolean);

/** An address that is one: http or https, and nothing a page could be made to run. */
function addressOf(value: unknown): string | null {
  const text = textOf(isObject(value) ? (value['@id'] ?? value.url) : value);
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function read(node: Record<string, unknown>): ExternalRecipe {
  const license = node.license;
  return {
    title: textOf(node.name),
    description: textOf(node.description),
    ingredientLines: listOf(node.recipeIngredient ?? node.ingredients).map(textOf).filter(Boolean),
    steps: stepsOf(node.recipeInstructions),
    servings: servingsOf(node.recipeYield),
    prepMinutes: minutesOf(node.prepTime),
    cookMinutes: minutesOf(node.cookTime),
    categories: [...new Set([...wordsOf(node.recipeCategory), ...wordsOf(node.keywords)])],
    url: addressOf(node.url) ?? addressOf(node['@id']),
    // A licence is named by its address or by its name; either is kept as it is written.
    license: addressOf(license) ?? (textOf(isObject(license) ? license.name : license) || null),
  };
}

export const schemaOrgRecipes: ExternalRecipeSource = {
  name: 'schema-org',
  read: (document) => recipeNodes(document).map(read),
};
