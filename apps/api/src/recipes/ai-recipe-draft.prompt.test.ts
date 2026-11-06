// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  buildDraftPrompt,
  type DraftPromptInput,
  type OfferedIngredient,
} from './ai-recipe-draft.prompt.js';

const CHICKEN: OfferedIngredient = {
  id: 'id-chicken',
  slug: 'chicken-breast',
  names: { en: 'Chicken breast', pl: 'Pierś z kurczaka' },
  category: 'meat',
  canonicalUnit: 'g',
  caloriesPer100: 120,
  proteinPer100: 22.54,
  gramsPerPiece: null,
};
const EGG: OfferedIngredient = {
  id: 'id-egg',
  slug: 'large-egg',
  names: { en: 'Large egg' },
  category: 'dairy',
  canonicalUnit: 'g',
  caloriesPer100: 143,
  proteinPer100: 12.6,
  gramsPerPiece: 50,
};
const OIL: OfferedIngredient = {
  id: 'id-oil',
  slug: 'olive-oil',
  names: { en: 'Olive oil', pl: 'Oliwa z oliwek' },
  category: 'fats_oils',
  canonicalUnit: 'ml',
  caloriesPer100: 804,
  proteinPer100: 0,
  gramsPerPiece: null,
};

const prompt = (input: Partial<DraftPromptInput> = {}) =>
  buildDraftPrompt({
    dietType: 'balanced',
    catalogue: [EGG, OIL, CHICKEN],
    favouriteIds: new Set(),
    targetLocales: ['en', 'pl'],
    existing: [],
    rested: [],
    ...input,
  });

describe('the prompt of a recipe a user asks a model for', () => {
  it('lists every ingredient offered with its names, what 100 g or ml of it holds, and the weight of a piece', () => {
    const { user } = prompt({ favouriteIds: new Set(['id-chicken']) });

    expect(user).toContain('Ingredient catalogue (slug: English name / Polish name):');
    expect(user).toContain(
      '- chicken-breast: Chicken breast / Pierś z kurczaka (meat; per 100 g: 120 kcal, 22.5 g protein) ⭐',
    );
    // A name the language has none of is the English one.
    expect(user).toContain(
      '- large-egg: Large egg / Large egg (dairy; per 100 g: 143 kcal, 12.6 g protein, a piece 50 g)',
    );
    expect(user).toContain(
      '- olive-oil: Olive oil / Oliwa z oliwek (fats_oils; per 100 ml: 804 kcal, 0 g protein)',
    );
  });

  it('asks for the cuisine as a dish of that kitchen, and says nothing of one when none is asked for', () => {
    expect(prompt({ cuisine: 'middle_eastern' }).user).toContain(
      '- Cuisine: middle eastern. Write a dish a home cook of the middle eastern kitchen would recognise as theirs',
    );
    expect(prompt().user).not.toContain('Cuisine:');
  });

  it('names the meal and whether it is a main dish or a small one', () => {
    expect(prompt({ mealType: 'dinner' }).user).toContain('- Meal: dinner, a main dish.');
    expect(prompt({ mealType: 'snack' }).user).toContain('- Meal: snack, a small dish');
  });

  it("states a diet's share of carbohydrate by the engine's own limits", () => {
    expect(prompt({ dietType: 'keto' }).user).toContain('under 10 % of the dish');
    expect(prompt({ dietType: 'low_carb' }).user).toContain('under 26 % of the dish');
    expect(prompt({ dietType: 'vegan' }).user).toContain(
      '- Diet: vegan. Every ingredient of the catalogue fits it.',
    );
  });

  it('sizes the recipe by the complexity asked for, and by the usual bounds without one', () => {
    const complex = prompt({ complexity: 'complex' }).user;
    expect(complex).toContain('- Complexity: complex: 10 to 16 ingredients, at most 25 steps');
    expect(complex).toContain('1. Use 10 to 16 ingredients');
    expect(complex).toContain('4. 2 to 25 steps');

    const plain = prompt().user;
    expect(plain).toContain('1. Use 3 to 12 ingredients');
    expect(plain).toContain('4. 2 to 12 steps');
  });

  it('asks for the calories and the time when they are given', () => {
    const { user } = prompt({
      kcalTarget: 500,
      prepTimeMaxMinutes: 30,
      cookingMethod: 'pan_fried',
    });

    expect(user).toContain('- Calories: about 500 kcal in the serving.');
    expect(user).toContain('- Time: preparing and cooking together take at most 30 minutes.');
    expect(user).toContain('- Cooking method: pan fried:');
  });

  it("lists the person's recipes by their ingredients and asks for another dish, only when there are some", () => {
    const { user } = prompt({
      mealType: 'lunch',
      cuisine: 'italian',
      existing: [
        ['pasta', 'chicken-breast', 'canned-tomatoes'],
        ['pasta', 'mozzarella'],
      ],
    });

    expect(user).toContain(
      'Recipes the person already has for lunch of the italian kitchen, one a line, by the slugs of their ingredients.',
    );
    expect(user).toContain('["pasta","chicken-breast","canned-tomatoes"]\n["pasta","mozzarella"]');
    expect(prompt().user).not.toContain('already has');
  });

  it('names the spices left out this time, and says nothing of them when none is', () => {
    expect(prompt({ rested: ['Cumin', 'Ground coriander'] }).user).toContain(
      "- Seasoning: the person's last dish of this kind was seasoned with cumin and ground coriander, which the catalogue leaves out this time.",
    );
    expect(prompt().user).not.toContain('Seasoning:');
  });

  it('asks for the text in every language of the draft, in the shape the reader of the answer takes', () => {
    const both = prompt();
    expect(both.system).toContain('English (en), Polish (pl)');
    expect(both.system).toContain('"titles":{"en":string,"pl":string}');
    expect(both.system).toContain('"steps":{"en":string[],"pl":string[]}');

    const english = prompt({ targetLocales: ['en'] });
    expect(english.system).toContain('"title":string,"description":string');
    expect(english.system).toContain('"steps":string[]}');
    expect(english.user).toContain('Ingredient catalogue (slug: English name):');
  });
});
