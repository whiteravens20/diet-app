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
    dietTags: ['balanced'],
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

  it('accepts high_protein dietTag even when olive-oil lacks high_protein in dietCompatibility', () => {
    // high_protein is a recipe-style tag, not a per-ingredient guarantee —
    // olive oil legitimately appears in high-protein recipes. Regression
    // guard for the post-Phase-D live-test fix.
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell({ dietTags: ['high_protein'] })]),
      resolveSlug,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when dietTags claim vegan but chicken is in the list', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell({ dietTags: ['vegan'] })]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('diet-conflict');
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
          dietTags: ['balanced'],
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
    if (!r.ok) expect(r.reason).toBe('step-count-too-high');
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

  it('rejects duplicate slug within the same batch', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([recipeShell(), recipeShell()]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('duplicate-slug-in-batch');
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
          dietTags: ['balanced'],
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
          dietTags: ['high_protein'],
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

  it('rejects when two batch candidates duplicate each other', () => {
    const r = validateRecipeBatch({
      targetLocales: ['en', 'pl'],
      rawOutput: wrap([
        recipeShell({ slug: 'first' }),
        recipeShell({ slug: 'second' }),
      ]),
      resolveSlug,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('duplicate-of-existing');
      expect(r.details).toContain('first');
    }
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
