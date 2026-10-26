// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The examples a prompt of the recipe generator shows a model are recipes the
 * generator itself would take: written in the shape an answer has, made of
 * ingredients every copy of the catalogue holds, and each in the complexity
 * band it is shown under. An example that breaks a rule teaches a model to
 * break it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Complexity } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { buildRecipeGeneratorPrompt, type CatalogueRow } from './recipe-generator.prompt.js';
import { validateRecipeBatch } from './recipe-generator.validate.js';

/** An ingredient as the curated data writes one. */
interface DataIngredient extends Omit<CatalogueRow, 'names' | 'gramsPerPiece' | 'density'> {
  name: { en: string };
  gramsPerPiece?: number;
  density?: number;
}

/** The curated ingredients, which every copy of the repository has. */
const catalogue: CatalogueRow[] = (
  JSON.parse(
    readFileSync(join(__dirname, '../../../../../data/ingredients.json'), 'utf8'),
  ) as DataIngredient[]
).map(({ name, gramsPerPiece, density, ...row }) => ({
  ...row,
  names: { en: name.en },
  gramsPerPiece: gramsPerPiece ?? null,
  density: density ?? null,
}));
const bySlug = new Map(catalogue.map((row) => [row.slug, row]));

const prompt = buildRecipeGeneratorPrompt({
  targetLocales: ['en', 'pl'],
  targets: { simple: 1, medium: 1, complex: 1 },
  catalogue,
});

/** A recipe of an answer, as far as these tests read one. */
interface Shown {
  slug: string;
  titles: Record<string, string>;
  mealTypes: string[];
}

/** The examples of the prompt, each with the band it stands under. */
function examples(): { band: Complexity; recipe: Shown }[] {
  const shown = prompt.slice(
    prompt.indexOf('Exemplar recipes'),
    prompt.indexOf('Ingredient catalogue'),
  );
  // What stands before the first band is the sentence that introduces them; after it a band and its recipe take turns.
  const parts = shown.split(/^(simple|medium|complex):$/m).slice(1);
  return Array.from({ length: parts.length / 2 }, (_, index) => ({
    band: parts[index * 2] as Complexity,
    recipe: JSON.parse(parts[index * 2 + 1]!) as Shown,
  }));
}

describe('the examples the recipe generator shows a model', () => {
  it('are there for every band', () => {
    expect([...new Set(examples().map(({ band }) => band))]).toEqual([
      'simple',
      'medium',
      'complex',
    ]);
  });

  it('are recipes the generator takes, each in the band it is shown under', () => {
    const shown = examples();
    const judged = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: JSON.stringify({ recipes: shown.map(({ recipe }) => recipe) }),
      resolveSlug: (slug) => bySlug.get(slug) ?? null,
      catalogueNames: catalogue.map((row) => ({ slug: row.slug, name: row.names.en ?? row.slug })),
    });

    expect(judged).toMatchObject({ ok: true, refused: [] });
    if (!judged.ok) return;
    expect(judged.candidates.map(({ slug, complexity }) => `${slug}: ${complexity}`)).toEqual(
      shown.map(({ band, recipe }) => `${recipe.slug}: ${band}`),
    );
  });

  it('keep the rules the prompt gives for a title and for the meals of a dish', () => {
    const shown = examples().map(({ recipe }) => recipe);

    // No diet, band or praise in a title or in the slug made of it.
    expect(
      shown
        .filter(({ slug, titles }) =>
          /\b(keto|low.carb|high.protein|vegan|vegetarian|simple|easy|quick|healthy)\b/i.test(
            `${slug} ${titles.en}`,
          ),
        )
        .map(({ slug }) => slug),
    ).toEqual([]);
    // A main dish is one at noon and in the evening.
    expect(
      shown
        .filter(({ mealTypes }) => mealTypes.includes('lunch') !== mealTypes.includes('dinner'))
        .map(({ slug }) => slug),
    ).toEqual([]);
  });
});

describe('the catalogue a prompt shows', () => {
  const shown = (targetLocales: ('en' | 'pl')[]): string => {
    const text = buildRecipeGeneratorPrompt({
      targetLocales,
      targets: { simple: 1, medium: 1, complex: 1 },
      catalogue: polish,
    });
    return text.slice(text.indexOf('slug\tname_en'));
  };
  /** Two rows as a run loads them: with the name each has in Polish. */
  const polish: CatalogueRow[] = catalogue
    .filter((row) => ['cottage-cheese', 'salt'].includes(row.slug))
    .map((row) => ({
      ...row,
      names: { ...row.names, pl: row.slug === 'salt' ? 'Sól' : 'Serek wiejski' },
    }));

  it('names each ingredient in every language the run writes in, so that a text calls it what the catalogue does', () => {
    expect(shown(['en', 'pl'])).toContain('slug\tname_en\tname_pl\tcategory');
    expect(shown(['en', 'pl'])).toContain('cottage-cheese\tCottage cheese\tSerek wiejski\tdairy');
  });

  it('shows no name of a language the run does not write in', () => {
    expect(shown(['en'])).toContain('slug\tname_en\tcategory');
    expect(shown(['en'])).not.toContain('Serek wiejski');
  });
});

describe('a prompt for a diet', () => {
  const asked = (dietTags?: ('keto' | 'vegan' | 'custom')[]): string =>
    buildRecipeGeneratorPrompt({
      targetLocales: ['en', 'pl'],
      targets: { simple: 1, medium: 1, complex: 1 },
      catalogue,
      dietTags,
      mealTypes: ['dinner'],
    });

  it('says what a day on that diet aims at, as the planner has it', () => {
    expect(asked(['keto'])).toContain(
      'A day on the keto diet aims at about 25 % of its energy from protein, 70 % from fat and 5 % from carbohydrate.',
    );
    expect(asked(['vegan'])).toContain(
      'A day on the vegan diet aims at about 20 % of its energy from protein, 28 % from fat and 52 % from carbohydrate.',
    );
  });

  it('says nothing of a split when no diet is asked for, or the one a profile sets for itself', () => {
    expect(asked()).not.toContain('aims at about');
    expect(asked(['custom'])).not.toContain('aims at about');
  });

  it('asks for a dish that suits the meal, and for every meal the dish suits', () => {
    expect(asked()).toContain('Every recipe MUST suit at least one of these meals: dinner.');
    expect(asked()).toContain('A dish is EITHER a main\n    dish OR a small one, never both');
  });
});

describe('a prompt for a way of cooking', () => {
  const asked = (cookingMethod?: 'pan_fried' | 'no_cook'): string =>
    buildRecipeGeneratorPrompt({
      targetLocales: ['en'],
      targets: { simple: 1, medium: 1, complex: 1 },
      catalogue,
      cookingMethod,
    });

  it('says how the recipes are to be cooked, in words, when the run names a way', () => {
    expect(asked('pan_fried')).toContain('- Cooking method: pan fried.');
    expect(asked('no_cook')).toContain('- Cooking method: no cook.');
  });

  it('says nothing of it when the run names none', () => {
    expect(asked()).not.toContain('Cooking method');
  });
});
