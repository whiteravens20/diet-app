// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Recipe-generator validator unit tests.
 *
 * Stubs the catalogue with a tiny fixture so the engine recompute is
 * deterministic. Every test pins one failure mode (matching plan §D3).
 */
import { describe, expect, it } from 'vitest';
import {
  jaccard,
  validateRecipeBatch,
  type ResolvedIngredient,
} from './recipe-generator.validate.js';

const CHICKEN: ResolvedIngredient = {
  slug: 'chicken-breast',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  caloriesPer100: 165,
  proteinPer100: 31,
  fatPer100: 3.6,
  carbsPer100: 0,
  allergens: [],
  dietCompatibility: ['balanced', 'high_protein', 'mediterranean'],
};
const RICE: ResolvedIngredient = {
  slug: 'white-rice',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  caloriesPer100: 130,
  proteinPer100: 2.7,
  fatPer100: 0.3,
  carbsPer100: 28,
  allergens: [],
  dietCompatibility: ['balanced', 'vegan', 'vegetarian', 'mediterranean'],
};
const SPINACH: ResolvedIngredient = {
  slug: 'spinach',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  caloriesPer100: 23,
  proteinPer100: 2.9,
  fatPer100: 0.4,
  carbsPer100: 3.6,
  allergens: [],
  dietCompatibility: ['balanced', 'vegan', 'vegetarian', 'keto', 'mediterranean'],
};
const PEANUT: ResolvedIngredient = {
  slug: 'peanut-butter',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  caloriesPer100: 588,
  proteinPer100: 25,
  fatPer100: 50,
  carbsPer100: 20,
  allergens: ['peanuts'],
  dietCompatibility: ['balanced', 'vegan', 'vegetarian', 'high_protein'],
};
const OLIVE: ResolvedIngredient = {
  slug: 'olive-oil',
  canonicalUnit: 'ml',
  gramsPerPiece: null,
  density: 0.91,
  caloriesPer100: 884,
  proteinPer100: 0,
  fatPer100: 100,
  carbsPer100: 0,
  allergens: [],
  dietCompatibility: ['balanced', 'vegan', 'vegetarian', 'keto', 'mediterranean', 'high_protein'],
};
const GARLIC: ResolvedIngredient = {
  slug: 'garlic',
  canonicalUnit: 'piece',
  gramsPerPiece: 3,
  density: null,
  caloriesPer100: 149,
  proteinPer100: 6.4,
  fatPer100: 0.5,
  carbsPer100: 33,
  allergens: [],
  dietCompatibility: ['balanced', 'vegan', 'vegetarian', 'keto', 'mediterranean', 'high_protein'],
};
const LEMON: ResolvedIngredient = {
  slug: 'lemon',
  canonicalUnit: 'piece',
  gramsPerPiece: 58,
  density: null,
  caloriesPer100: 29,
  proteinPer100: 1.1,
  fatPer100: 0.3,
  carbsPer100: 9.3,
  allergens: [],
  dietCompatibility: ['balanced', 'vegan', 'vegetarian', 'keto', 'mediterranean', 'high_protein'],
};
const CATALOGUE = new Map<string, ResolvedIngredient>([
  [CHICKEN.slug, CHICKEN],
  [RICE.slug, RICE],
  [SPINACH.slug, SPINACH],
  [PEANUT.slug, PEANUT],
  [OLIVE.slug, OLIVE],
  [GARLIC.slug, GARLIC],
  [LEMON.slug, LEMON],
]);
const resolveSlug = (slug: string) => CATALOGUE.get(slug) ?? null;

function recipeShell(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'chicken-rice-bowl',
    titles: { en: 'Chicken rice bowl', pl: 'Miska ryżu z kurczakiem' },
    descriptions: {
      en: 'Lean chicken on rice with spinach.',
      pl: 'Chudy kurczak na ryżu ze szpinakiem.',
    },
    steps: {
      en: ['Cook the rice.', 'Sear the chicken.', 'Serve with spinach.'],
      pl: ['Ugotuj ryż.', 'Podsmaż kurczaka.', 'Podawaj ze szpinakiem.'],
    },
    servings: 2,
    mealTypes: ['lunch'],
    prepMinutes: 10,
    cookMinutes: 25,
    difficulty: 'medium',
    ingredients: [
      { slug: 'chicken-breast', quantity: 300, unit: 'g' },
      { slug: 'white-rice', quantity: 160, unit: 'g' },
      { slug: 'spinach', quantity: 120, unit: 'g' },
      { slug: 'olive-oil', quantity: 10, unit: 'ml' },
      { slug: 'garlic', quantity: 2, unit: 'piece' },
      { slug: 'lemon', quantity: 1, unit: 'piece' },
    ],
    ...overrides,
  };
}

function wrap(recipes: unknown[]): string {
  return JSON.stringify({ recipes });
}

describe('validateRecipeBatch', () => {
  it('accepts a well-formed recipe + recomputes nutrition + tags complexity', () => {
    const result = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell()]),
      resolveSlug,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    // 6 ingredients → medium band; engine = ~822 / 2 ≈ 411.
    expect(c.caloriesPerServing).toBe(411);
    expect(c.complexity).toBe('medium');
    expect(c.allergens).toEqual([]);
  });

  it('rejects malformed JSON', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: 'not json',
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-json');
  });

  it('rejects when `recipes` key is missing', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: '{ "items": [] }',
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-recipes-key');
  });

  it('rejects when targetLocale is missing from titles', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell({ titles: { en: 'Only EN' } })]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing-locale');
  });

  it('rejects on unknown slug', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          ingredients: [
            { slug: 'chicken-breast', quantity: 200, unit: 'g' },
            { slug: 'pixie-dust', quantity: 5, unit: 'g' },
            { slug: 'white-rice', quantity: 160, unit: 'g' },
          ],
        }),
      ]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown-slug');
      expect(r.key).toContain('pixie-dust');
    }
  });

  describe('the diets of a recipe', () => {
    const vegan = {
      ingredients: [
        { slug: 'white-rice', quantity: 160, unit: 'g' },
        { slug: 'spinach', quantity: 120, unit: 'g' },
        { slug: 'peanut-butter', quantity: 30, unit: 'g' },
        { slug: 'olive-oil', quantity: 10, unit: 'ml' },
        { slug: 'garlic', quantity: 2, unit: 'piece' },
        { slug: 'lemon', quantity: 1, unit: 'piece' },
      ],
    };

    it('are worked out from its ingredients, whatever the model claims', () => {
      const r = validateRecipeBatch({
        targetLocales: ['en', 'pl'],
        rawOutput: wrap([recipeShell({ dietTags: ['vegan', 'keto', 'high_protein'] })]),
        resolveSlug,
      });
      if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
      // Chicken, rice and vegetables: every ingredient is mediterranean, the
      // chicken is not vegetarian, and a quarter of the energy comes from
      // carbohydrate: low, but far from ketogenic.
      expect(r.candidates[0].dietTags).toEqual(['mediterranean', 'low_carb']);
    });

    it('include vegan and vegetarian when every ingredient is', () => {
      const r = validateRecipeBatch({
        targetLocales: ['en', 'pl'],
        rawOutput: wrap([recipeShell(vegan)]),
        resolveSlug,
      });
      if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
      expect(r.candidates[0].dietTags).toEqual(expect.arrayContaining(['vegetarian', 'vegan']));
    });

    it('reject a recipe that does not qualify for a diet the run asked for', () => {
      const r = validateRecipeBatch({
        targetLocales: ['en', 'pl'],
        rawOutput: wrap([recipeShell({ dietTags: ['vegan'] })]),
        resolveSlug,
        requiredDiets: ['vegan'],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('diet-conflict');
        expect(r.details).toContain('asked for vegan');
      }
    });

    it('let a recipe through that qualifies for every diet the run asked for', () => {
      const r = validateRecipeBatch({
        targetLocales: ['en', 'pl'],
        rawOutput: wrap([recipeShell(vegan)]),
        resolveSlug,
        requiredDiets: ['vegan', 'vegetarian'],
      });
      expect(r.ok).toBe(true);
    });

    it('do not narrow a run asked for a diet that takes any recipe', () => {
      const r = validateRecipeBatch({
        targetLocales: ['en', 'pl'],
        rawOutput: wrap([recipeShell()]),
        resolveSlug,
        requiredDiets: ['high_protein', 'balanced'],
      });
      expect(r.ok).toBe(true);
    });
  });

  it('auto-detects allergens from ingredients (peanut → peanuts)', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          ingredients: [
            { slug: 'chicken-breast', quantity: 250, unit: 'g' },
            { slug: 'white-rice', quantity: 160, unit: 'g' },
            { slug: 'spinach', quantity: 80, unit: 'g' },
            { slug: 'peanut-butter', quantity: 30, unit: 'g' },
            { slug: 'olive-oil', quantity: 10, unit: 'ml' },
            { slug: 'garlic', quantity: 2, unit: 'piece' },
          ],
        }),
      ]),
      resolveSlug,
    });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.candidates[0].allergens).toEqual(['peanuts']);
  });

  it('rejects when AI volunteers nutrition that diverges > 5%', () => {
    // Engine = 411; claim 900 is > 100% off.
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell({ caloriesPerServing: 900 })]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invented-nutrition');
  });

  it('accepts AI-volunteered nutrition within 5% delta', () => {
    // Engine = 411; claim 420 → ~2.2% delta, well inside tolerance.
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell({ caloriesPerServing: 420 })]),
      resolveSlug,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects recipes outside every complexity band (2 ingredients)', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          ingredients: [
            { slug: 'chicken-breast', quantity: 200, unit: 'g' },
            { slug: 'white-rice', quantity: 100, unit: 'g' },
          ],
        }),
      ]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ingredient-count-out-of-bands');
  });

  it('rejects recipes with too many steps', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          // 26 steps — over the complex max of 25.
          steps: {
            en: new Array(26).fill('Do something.'),
            pl: new Array(26).fill('Coś zrób.'),
          },
        }),
      ]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    // More steps than any recipe may have: the rule for every recipe speaks before the bands do.
    if (!r.ok) expect(r.reason).toBe('too-many-steps');
  });

  it('rejects empty step strings', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          steps: { en: ['Cook.', '', 'Serve.'], pl: ['Gotuj.', 'X', 'Podawaj.'] },
        }),
      ]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty-step');
  });

  it('rejects LLM yap in steps', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          steps: {
            en: ['Cook rice.', 'Note: as an AI, I would also recommend salt.', 'Serve.'],
            pl: ['Ugotuj ryż.', 'Dopraw solą.', 'Podawaj.'],
          },
        }),
      ]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('llm-yap');
  });

  it('rejects invalid quantity (zero / negative)', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          ingredients: [
            { slug: 'chicken-breast', quantity: 0, unit: 'g' },
            { slug: 'white-rice', quantity: 160, unit: 'g' },
            { slug: 'spinach', quantity: 80, unit: 'g' },
          ],
        }),
      ]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-quantity');
  });

  it('keeps the first of two recipes under one slug in an answer, and refuses the second', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell(), recipeShell()]),
      resolveSlug,
    });
    expect(r).toMatchObject({ ok: true, refused: [{ reason: 'duplicate-slug-in-batch', key: 'chicken-rice-bowl' }] });
    expect(r.ok && r.candidates.map((recipe) => recipe.slug)).toEqual(['chicken-rice-bowl']);
  });

  it('judges each recipe of an answer by itself: what passes is kept, what does not is named with its reason', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell(),
        recipeShell({ slug: 'dragon-bowl', titles: { en: 'Dragon bowl', pl: 'Smocza miska' }, ingredients: [{ slug: 'dragon-fruit', quantity: 100, unit: 'g' }, { slug: 'white-rice', quantity: 80, unit: 'g' }, { slug: 'olive-oil', quantity: 10, unit: 'ml' }] }),
        recipeShell({ slug: 'no-steps', titles: { en: 'A dish without steps', pl: 'Danie bez kroków' }, steps: { en: [''], pl: [''] } }),
      ]),
      resolveSlug,
    });

    expect(r.ok && r.candidates.map((recipe) => recipe.slug)).toEqual(['chicken-rice-bowl']);
    expect(r.ok && r.refused).toEqual([
      { reason: 'unknown-slug', key: 'dragon-bowl.dragon-fruit' },
      { reason: 'empty-step', key: 'no-steps.steps' },
    ]);
  });

  it('says the first refusal of an answer nothing can be kept of', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell({ ingredients: [{ slug: 'dragon-fruit', quantity: 100, unit: 'g' }, { slug: 'white-rice', quantity: 80, unit: 'g' }, { slug: 'olive-oil', quantity: 10, unit: 'ml' }] }), recipeShell({ slug: 'second', steps: { en: [''], pl: [''] } })]),
      resolveSlug,
    });

    expect(r).toEqual({ ok: false, reason: 'unknown-slug', key: 'chicken-rice-bowl.dragon-fruit' });
  });

  it('refuses a recipe for a meal that was not asked for, and takes one that names it among others', () => {
    const forMeals = (mealTypes: string[], requiredMeals: string[]) => {
      const result = validateRecipeBatch({ targetLocales: ['en', 'pl'], rawOutput: wrap([recipeShell({ mealTypes })]), resolveSlug, requiredMeals });
      return result.ok ? 'accepted' : `${result.reason} at ${result.key}`;
    };

    expect(forMeals(['lunch'], ['breakfast'])).toBe('meal-not-asked-for at chicken-rice-bowl');
    expect(forMeals(['lunch', 'dinner'], ['dinner'])).toBe('accepted');
    expect(forMeals(['lunch'], [])).toBe('accepted');
  });

  describe('a slug or a title another recipe has', () => {
    /** A second recipe unlike the first: its own slug and title, other ingredients, quick enough for the simple band. */
    const other = {
      slug: 'lemon-chicken',
      titles: { en: 'Lemon chicken', pl: 'Kurczak z cytryną' },
      prepMinutes: 5,
      cookMinutes: 15,
      ingredients: [
        { slug: 'chicken-breast', quantity: 300, unit: 'g' },
        { slug: 'lemon', quantity: 1, unit: 'piece' },
        { slug: 'peanut-butter', quantity: 20, unit: 'g' },
      ],
    };
    const refusal = (recipes: unknown[], taken: { slugs?: string[]; titles?: string[] } = {}) => {
      const result = validateRecipeBatch({
        targetLocales: ['en', 'pl'],
        rawOutput: wrap(recipes),
        resolveSlug,
        takenSlugs: new Set(taken.slugs ?? []),
        takenTitles: new Set(taken.titles ?? []),
      });
      const refused = result.ok ? result.refused : [result];
      return refused.length === 0 ? 'accepted' : refused.map((one) => `${one.reason} at ${one.key}`).join('; ');
    };

    it('is refused: a slug names one recipe', () => {
      expect(refusal([recipeShell()], { slugs: ['chicken-rice-bowl'] })).toBe('slug-taken at chicken-rice-bowl');
      expect(refusal([recipeShell()], { slugs: ['another-bowl'] })).toBe('accepted');
    });

    it('is refused: an English title names one recipe, however it is cased', () => {
      expect(refusal([recipeShell({ titles: { en: 'CHICKEN Rice Bowl', pl: 'Miska ryżu z kurczakiem' } })], { titles: ['chicken rice bowl'] })).toBe('title-taken at chicken-rice-bowl');
      // The Polish title is nobody's key: only the English one is compared.
      expect(refusal([recipeShell()], { titles: ['miska ryżu z kurczakiem'] })).toBe('accepted');
    });

    it('is refused within one answer too, by the title as by the slug', () => {
      expect(refusal([recipeShell(), recipeShell({ ...other, titles: { en: 'chicken rice BOWL', pl: 'Inna miska' } })])).toBe('duplicate-title-in-batch at lemon-chicken');
      expect(refusal([recipeShell(), recipeShell(other)])).toBe('accepted');
    });
  });

  it('classifies simple recipes correctly', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          slug: 'quick-rice',
          ingredients: [
            { slug: 'white-rice', quantity: 120, unit: 'g' },
            { slug: 'spinach', quantity: 80, unit: 'g' },
            { slug: 'chicken-breast', quantity: 200, unit: 'g' },
          ],
          steps: {
            en: ['Cook the rice.', 'Sear chicken.', 'Wilt spinach.'],
            pl: ['Ugotuj ryż.', 'Podsmaż kurczaka.', 'Podsmaż szpinak.'],
          },
          prepMinutes: 5,
          cookMinutes: 15,
        }),
      ]),
      resolveSlug,
    });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.candidates[0].complexity).toBe('simple');
  });

  it('rejects a candidate that duplicates an existing recipe by ingredient set', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell()]),
      resolveSlug,
      existingRecipes: [
        {
          slug: 'existing-chicken-rice-bowl',
          ingredientSlugs: [
            'chicken-breast',
            'white-rice',
            'spinach',
            'olive-oil',
            'garlic',
            'lemon',
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('duplicate-of-existing');
      expect(r.details).toContain('existing-chicken-rice-bowl');
    }
  });

  it('allows a recipe with the same hero ingredient but a different supporting cast', () => {
    // yogurt+apples vs yogurt+bananas — user's example. One overlap of three.
    // J = 1/5 = 0.20 ≪ 0.75 → passes.
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({
          slug: 'olive-lemon-chicken',
          ingredients: [
            { slug: 'chicken-breast', quantity: 200, unit: 'g' },
            { slug: 'olive-oil', quantity: 10, unit: 'ml' },
            { slug: 'lemon', quantity: 1, unit: 'piece' },
          ],
          steps: {
            en: ['Mix oil and lemon.', 'Roast chicken.', 'Rest, slice, serve.'],
            pl: ['Wymieszaj oliwę z cytryną.', 'Upiecz kurczaka.', 'Odpocznij, pokrój, podaj.'],
          },
          prepMinutes: 5,
          cookMinutes: 20,
        }),
      ]),
      resolveSlug,
      existingRecipes: [
        {
          slug: 'rice-and-spinach-chicken',
          ingredientSlugs: ['chicken-breast', 'white-rice', 'spinach', 'garlic'],
        },
      ],
    });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.candidates).toHaveLength(1);
  });

  it('refuses the second of two recipes of an answer that are made of the same, and keeps the first', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({ slug: 'first' }),
        recipeShell({ slug: 'second', titles: { en: 'The same bowl by another name', pl: 'Ta sama miska' } }),
      ]),
      resolveSlug,
    });
    expect(r.ok && r.candidates.map((recipe) => recipe.slug)).toEqual(['first']);
    expect(r.ok && r.refused).toEqual([{ reason: 'duplicate-of-existing', key: 'second', details: expect.stringContaining('first') }]);
  });
});

describe('what a batch answer may not put into the queue', () => {
  const rejected = (overrides: Record<string, unknown>) => {
    const result = validateRecipeBatch({ targetLocales: ['en', 'pl'], rawOutput: wrap([recipeShell(overrides)]), resolveSlug });
    return result.ok ? 'accepted' : `${result.reason} at ${result.key}`;
  };

  it('markup, in a title, a description, a step or a note', () => {
    expect(rejected({ titles: { en: 'Dish <img src=x onerror=alert(1)>', pl: 'Danie' } })).toBe('markup at chicken-rice-bowl.titles.en');
    expect(rejected({ descriptions: { en: 'Fine.', pl: '<script>alert(1)</script>' } })).toBe('markup at chicken-rice-bowl.descriptions.pl');
    expect(rejected({ steps: { en: ['<svg onload=alert(1)>', 'Serve.'], pl: ['Gotuj.', 'Podawaj.'] } })).toBe('markup at chicken-rice-bowl.steps.en[0]');
    expect(rejected({ ingredients: [{ slug: 'chicken-breast', quantity: 300, unit: 'g', note: '<b>diced</b>' }] })).toBe('markup at chicken-rice-bowl.ingredients[0].note');
  });

  it('a hidden character that reorders or splits what is read', () => {
    expect(rejected({ titles: { en: 'Chicken \u202ebowl', pl: 'Miska' } })).toBe('markup at chicken-rice-bowl.titles.en');
    expect(rejected({ titles: { en: 'Chicken\u200b bowl', pl: 'Miska' } })).toBe('markup at chicken-rice-bowl.titles.en');
  });

  it('text longer than a recipe card holds', () => {
    expect(rejected({ titles: { en: 'a'.repeat(121), pl: 'Miska' } })).toBe('text-too-long at chicken-rice-bowl.titles.en');
    expect(rejected({ descriptions: { en: 'a'.repeat(601), pl: 'Opis.' } })).toBe('text-too-long at chicken-rice-bowl.descriptions.en');
    expect(rejected({ steps: { en: ['a'.repeat(301)], pl: ['Krok.'] } })).toBe('text-too-long at chicken-rice-bowl.steps.en[0]');
  });

  it('more of one ingredient than a serving can hold', () => {
    expect(rejected({ ingredients: [{ slug: 'white-rice', quantity: 10_000, unit: 'g' }, { slug: 'spinach', quantity: 100, unit: 'g' }, { slug: 'olive-oil', quantity: 10, unit: 'ml' }] })).toBe(
      'quantity-too-large at chicken-rice-bowl.ingredients[0].quantity',
    );
  });

  it('servings or times that are not those of a meal', () => {
    expect(rejected({ servings: 0 })).toBe('servings-out-of-range at chicken-rice-bowl.servings');
    expect(rejected({ servings: 500 })).toBe('servings-out-of-range at chicken-rice-bowl.servings');
    expect(rejected({ cookMinutes: -5 })).toBe('time-out-of-range at chicken-rice-bowl.cookMinutes');
  });

  it('a meal the planner does not know, a difficulty or a unit there is none of', () => {
    expect(rejected({ mealTypes: ['brunch'] })).toBe('invalid-meal-type at chicken-rice-bowl.mealTypes[0]');
    expect(rejected({ difficulty: 'trivial' })).toBe('invalid-difficulty at chicken-rice-bowl.difficulty');
    expect(rejected({ ingredients: [{ slug: 'white-rice', quantity: 1, unit: 'cup' }] })).toBe('invalid-unit at chicken-rice-bowl.ingredients[0].unit');
  });

  it('a slug that is not one: taken as the plain slug it means, and refused when it means none', () => {
    const slugOf = (slug: string) => {
      const result = validateRecipeBatch({ targetLocales: ['en', 'pl'], rawOutput: wrap([recipeShell({ slug })]), resolveSlug });
      return result.ok ? result.candidates[0]!.slug : result.reason;
    };

    // A model writes the word as its language spells it: the slug is the plain one.
    expect(slugOf('zucchini-and-feta-sauté')).toBe('zucchini-and-feta-saute');
    expect(slugOf('Zucchini and Feta')).toBe('zucchini-and-feta');
    // What looks like a path is no path once it is a slug.
    expect(slugOf('../../etc/passwd')).toBe('etc-passwd');
    expect(slugOf('../..')).toBe('invalid-slug');
    expect(slugOf('a'.repeat(81))).toBe('invalid-slug');
  });

  it('keeps text as one plain line, and text for the languages of the run only', () => {
    const result = validateRecipeBatch({
      targetLocales: ['en'],
      rawOutput: wrap([recipeShell({ titles: { en: ' Chicken\n rice  bowl ', pl: 'Miska', de: 'Schüssel' }, descriptions: { en: 'Lean\tchicken.', pl: 'Kurczak.' } })]),
      resolveSlug,
    });

    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.candidates[0]!.titles).toEqual({ en: 'Chicken rice bowl' });
    expect(result.candidates[0]!.descriptions).toEqual({ en: 'Lean chicken.' });
    expect(Object.keys(result.candidates[0]!.steps)).toEqual(['en']);
  });
});

describe('jaccard', () => {
  it('returns 1.0 for identical sets', () => {
    expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });
  it('returns 0 for disjoint sets', () => {
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
  });
  it('returns 1/3 for yogurt+apple vs yogurt+banana', () => {
    expect(jaccard(['yogurt', 'apple'], ['yogurt', 'banana'])).toBeCloseTo(1 / 3, 5);
  });
  it('ignores order and duplicates within each input', () => {
    expect(jaccard(['a', 'b', 'a'], ['b', 'a'])).toBe(1);
  });
});
