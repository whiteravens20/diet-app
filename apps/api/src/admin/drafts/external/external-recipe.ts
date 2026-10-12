// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A recipe as it comes from somewhere else, before anything of it is
 * resolved against the catalogue: its text, its ingredient lines as they were
 * written, and where it is from. An adapter turns what a source hands over
 * into these; everything after that is the same for every source.
 */
export interface ExternalRecipe {
  title: string;
  description: string;
  /** The lines of the ingredient list, as written: "200 g rolled oats". */
  ingredientLines: string[];
  steps: string[];
  /** Null where the source does not say. */
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  /** What the source files the recipe under: "Breakfast", "Main course", in lower case. */
  categories: string[];
  /** The address of the recipe at its source, when it gives one. */
  url: string | null;
  /** The licence the source says the recipe is under, when it says. */
  license: string | null;
}

/** A source of recipes: its name, and how what it hands over is read. */
export interface ExternalRecipeSource {
  /** How the source is named in a draft's history: `schema-org`. */
  name: string;
  /** The recipes of a document of the source. A document that holds none gives none. */
  read(document: unknown): ExternalRecipe[];
}
