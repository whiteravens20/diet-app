// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RECIPE_FORMS, type Macros } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { energyShares, MACROS_OFF, splitDistance } from './nutrition.js';
import {
  bestTopping,
  holdsAMeatStandIn,
  LEAST_GAIN,
  TOPPING_BY_KEY,
  TOPPINGS,
  toppingRefusal,
  type Figures,
  type ToppingDish,
  type ToppingEater,
  type ToppingFood,
  type ToppingOption,
  type ToppingPlace,
} from './toppings.js';

interface CatalogueFood {
  slug: string;
  canonicalUnit: string;
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
  allergens: string[];
  dietCompatibility: string[];
  proteinKind?: string;
}
const catalogue = new Map(
  (
    JSON.parse(
      readFileSync(resolve(__dirname, '../../../../data/ingredients.json'), 'utf8'),
    ) as CatalogueFood[]
  ).map((food) => [food.slug, food]),
);

/** The topping's food as the catalogue has it, its id its slug. */
const option = (key: string): ToppingOption => {
  const topping = TOPPING_BY_KEY.get(key)!;
  const food = catalogue.get(topping.slug)!;
  return {
    topping,
    food: {
      id: food.slug,
      allergens: food.allergens,
      dietCompatibility: food.dietCompatibility,
      proteinKind: food.proteinKind ?? null,
    },
    per100: {
      calories: food.caloriesPer100,
      protein: food.proteinPer100,
      fat: food.fatPer100,
      carbs: food.carbsPer100,
    },
  };
};
const ALL = TOPPINGS.map((topping) => option(topping.key));
const food = (key: string): ToppingFood => option(key).food;

const anyone: ToppingEater = {
  diet: 'balanced',
  allergens: [],
  excluded: new Set(),
  disliked: new Set(),
  fullKinds: new Set(),
};
const PLATE: ToppingDish = {
  taste: 'savoury',
  form: 'plate',
  starchBase: 'none',
  meatStandIn: false,
};
const RICE_PLATE: ToppingDish = {
  taste: 'savoury',
  form: 'plate',
  starchBase: 'rice',
  meatStandIn: false,
};
const SOUP: ToppingDish = {
  taste: 'savoury',
  form: 'soup',
  starchBase: 'none',
  meatStandIn: false,
};
const SALAD: ToppingDish = {
  taste: 'savoury',
  form: 'salad',
  starchBase: 'none',
  meatStandIn: false,
};
const PORRIDGE: ToppingDish = {
  taste: 'sweet',
  form: 'porridge_dessert',
  starchBase: 'groats',
  meatStandIn: false,
};

const topping = (key: string) => TOPPING_BY_KEY.get(key)!;

describe('the list of toppings', () => {
  it('holds foods of the catalogue, each once, with amounts in their own unit', () => {
    expect(new Set(TOPPINGS.map((one) => one.key)).size).toBe(TOPPINGS.length);
    for (const one of TOPPINGS) {
      const food = catalogue.get(one.slug);
      expect(food, one.slug).toBeDefined();
      expect(one.amounts.length).toBeGreaterThan(0);
      expect([...one.amounts].sort((a, b) => a - b)).toEqual(one.amounts);
      expect(one.amounts.every((amount) => amount > 0)).toBe(true);
      expect(one.forms.every((form) => (RECIPE_FORMS as readonly string[]).includes(form))).toBe(
        true,
      );
    }
  });
});

describe('the one check of a topping', () => {
  it('lets a topping that goes with the dish onto the plate of whoever may eat it', () => {
    expect(toppingRefusal(topping('egg'), food('egg'), SALAD, 'lunch', anyone)).toBeNull();
    expect(
      toppingRefusal(topping('rye_bread'), food('rye_bread'), SOUP, 'lunch', anyone),
    ).toBeNull();
    expect(
      toppingRefusal(topping('greek_yogurt'), food('greek_yogurt'), PORRIDGE, 'breakfast', anyone),
    ).toBeNull();
  });

  it('never puts a second starch beside the dish’s own: no bread with rice', () => {
    expect(
      toppingRefusal(topping('rye_bread'), food('rye_bread'), RICE_PLATE, 'lunch', anyone),
    ).toBe('second_starch');
    expect(toppingRefusal(topping('potatoes'), food('potatoes'), RICE_PLATE, 'lunch', anyone)).toBe(
      'second_starch',
    );
  });

  it('keeps the dish’s taste: no yogurt in a soup, no egg on a sweet porridge', () => {
    expect(
      toppingRefusal(topping('greek_yogurt'), food('greek_yogurt'), SOUP, 'lunch', anyone),
    ).toBe('taste');
    expect(
      toppingRefusal(
        topping('egg'),
        food('egg'),
        { ...PORRIDGE, starchBase: 'none' },
        'lunch',
        anyone,
      ),
    ).toBe('taste');
  });

  it('suits the dish’s form', () => {
    expect(toppingRefusal(topping('egg'), food('egg'), SOUP, 'lunch', anyone)).toBe('form');
    expect(toppingRefusal(topping('rice'), food('rice'), SALAD, 'lunch', anyone)).toBe('form');
  });

  it('keeps the plate beside a dish built on tofu, tempeh or seitan of plants: no turkey with tofu', () => {
    const onTofu: ToppingDish = { ...PLATE, meatStandIn: true };
    const plants = (key: string) => food(key).dietCompatibility.includes('vegan');
    const passing = (dish: ToppingDish, meal: 'lunch' | 'dinner' | 'breakfast') =>
      ALL.filter((one) => toppingRefusal(one.topping, one.food, dish, meal, anyone) === null).map(
        (one) => one.topping.key,
      );
    for (const meal of ['breakfast', 'lunch', 'dinner'] as const) {
      // What a plate takes beside any such dish, less what is not of plants.
      expect(passing(onTofu, meal)).toEqual(passing(PLATE, meal).filter(plants));
      for (const key of passing(PLATE, meal).filter((one) => !plants(one))) {
        expect(
          toppingRefusal(topping(key), food(key), onTofu, meal, anyone),
          `${key} at ${meal}`,
        ).toBe('plant_dish');
      }
    }
    expect(passing(PLATE, 'lunch').filter((key) => !plants(key))).toEqual(['egg', 'turkey']);
    // Tuna goes on a salad or a sandwich, and not on one of tofu.
    expect(
      toppingRefusal(
        topping('tuna'),
        food('tuna'),
        { ...SALAD, meatStandIn: true },
        'lunch',
        anyone,
      ),
    ).toBe('plant_dish');
    expect(toppingRefusal(topping('turkey'), food('turkey'), onTofu, 'lunch', anyone)).toBe(
      'plant_dish',
    );
    expect(passing(onTofu, 'lunch')).toEqual(expect.arrayContaining(['tofu', 'chickpeas']));
    // A sweet dish on tofu keeps its fruit and nuts, and leaves the yogurt and the curd.
    const sweetOnTofu: ToppingDish = { ...PORRIDGE, starchBase: 'none', meatStandIn: true };
    expect(passing(sweetOnTofu, 'breakfast')).toEqual(
      expect.arrayContaining(['banana', 'blueberries', 'walnuts']),
    );
    expect(
      toppingRefusal(
        topping('greek_yogurt'),
        food('greek_yogurt'),
        sweetOnTofu,
        'breakfast',
        anyone,
      ),
    ).toBe('plant_dish');
  });

  it('knows a dish built on a stand-in for meat by its ingredients, whole words of their slugs', () => {
    expect(holdsAMeatStandIn(['tofu', 'buckwheat'])).toBe(true);
    expect(holdsAMeatStandIn(['firm-tofu'])).toBe(true);
    expect(holdsAMeatStandIn([null, 'smoked-tempeh-strips'])).toBe(true);
    expect(holdsAMeatStandIn(['seitan'])).toBe(true);
    expect(holdsAMeatStandIn(['chicken-breast', 'tofurky-roast', null])).toBe(false);
    expect(holdsAMeatStandIn([])).toBe(false);
  });

  it('goes only to a meal it goes with: no rice at breakfast, no turkey breast either, no yogurt at dinner', () => {
    expect(toppingRefusal(topping('rice'), food('rice'), PLATE, 'breakfast', anyone)).toBe('meal');
    expect(toppingRefusal(topping('rice'), food('rice'), PLATE, 'lunch', anyone)).toBeNull();
    expect(toppingRefusal(topping('turkey'), food('turkey'), PLATE, 'breakfast', anyone)).toBe(
      'meal',
    );
    expect(
      toppingRefusal(topping('greek_yogurt'), food('greek_yogurt'), PORRIDGE, 'dinner', anyone),
    ).toBe('meal');
    // Every topping goes with some meal, and a sprinkle with every one.
    for (const one of TOPPINGS) expect(one.meals.length).toBeGreaterThan(0);
    expect(topping('pumpkin_seeds').meals).toHaveLength(5);
  });

  it('fits the diet of the person whose plate it is on', () => {
    expect(
      toppingRefusal(topping('egg'), food('egg'), SALAD, 'lunch', { ...anyone, diet: 'vegan' }),
    ).toBe('diet');
    expect(
      toppingRefusal(topping('rye_bread'), food('rye_bread'), PLATE, 'lunch', {
        ...anyone,
        diet: 'keto',
      }),
    ).toBe('diet');
    expect(
      toppingRefusal(topping('tofu'), food('tofu'), PLATE, 'lunch', { ...anyone, diet: 'vegan' }),
    ).toBeNull();
  });

  it('brings none of their allergens, nothing they rule out or dislike, no kind of protein they have no more meals of', () => {
    expect(
      toppingRefusal(topping('walnuts'), food('walnuts'), SALAD, 'lunch', {
        ...anyone,
        allergens: ['nuts'],
      }),
    ).toBe('allergen');
    expect(
      toppingRefusal(topping('tofu'), food('tofu'), PLATE, 'lunch', {
        ...anyone,
        excluded: new Set(['tofu']),
      }),
    ).toBe('excluded');
    expect(
      toppingRefusal(topping('tofu'), food('tofu'), PLATE, 'lunch', {
        ...anyone,
        disliked: new Set(['tofu']),
      }),
    ).toBe('disliked');
    expect(
      toppingRefusal(topping('egg'), food('egg'), SALAD, 'lunch', {
        ...anyone,
        fullKinds: new Set(['eggs']),
      }),
    ).toBe('protein_kind');
  });
});

describe('the topping a day is given', () => {
  const shares = (held: Macros, aim: Macros) =>
    splitDistance(energyShares(held)!, energyShares(aim)!);
  const after = (day: Figures, target: number, picked: { key: string; amount: number }): Macros => {
    const per100 = option(picked.key).per100;
    const added = { calories: (per100.calories * picked.amount) / 100 };
    const rest = (target - added.calories) / day.calories;
    return {
      protein: day.protein * rest + (per100.protein * picked.amount) / 100,
      fat: day.fat * rest + (per100.fat * picked.amount) / 100,
      carbs: day.carbs * rest + (per100.carbs * picked.amount) / 100,
    };
  };

  // A high-protein day of 2,800 kcal aims at 245 g of protein, 93 g of fat and 245 g of carbohydrate.
  const highProtein: Macros = { protein: 245, fat: 93, carbs: 245 };
  // What shared balanced dishes give it: 2,800 kcal with only 140 g of protein.
  const shortOfProtein: Figures = { calories: 2800, protein: 140, fat: 100, carbs: 335 };

  it('makes up for protein a high-protein person lacks, at a shared plate', () => {
    const picked = bestTopping(
      shortOfProtein,
      2800,
      highProtein,
      [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }],
      ALL,
      anyone,
    )!;
    expect(picked.mealId).toBe('lunch');
    expect(
      (option(picked.key).per100.protein * 4) / option(picked.key).per100.calories,
    ).toBeGreaterThan(0.5);
    expect(shares(after(shortOfProtein, 2800, picked), highProtein)).toBeLessThan(
      shares(shortOfProtein, highProtein) - LEAST_GAIN,
    );
  });

  // A balanced day of 1,900 kcal aims at about 95 g of protein, 63 g of fat and 238 g of carbohydrate.
  const balanced: Macros = { protein: 95, fat: 63, carbs: 238 };
  // What low-carbohydrate shared dishes give it.
  const shortOfCarbs: Figures = { calories: 1900, protein: 120, fat: 120, carbs: 85 };

  it('gives the starch a balanced person lacks beside a dish that has none, and never beside one that has', () => {
    const picked = bestTopping(
      shortOfCarbs,
      1900,
      balanced,
      [{ mealId: 'dinner', meal: 'dinner', dish: PLATE }],
      ALL,
      anyone,
    )!;
    expect(topping(picked.key).starch).not.toBeNull();
    const onRice = bestTopping(
      shortOfCarbs,
      1900,
      balanced,
      [{ mealId: 'dinner', meal: 'dinner', dish: RICE_PLATE }],
      ALL,
      anyone,
    );
    expect(onRice === null || topping(onRice.key).starch === null).toBe(true);
  });

  it('gives a breakfast short of carbohydrate bread, never the rice or potatoes of a lunch', () => {
    const picked = bestTopping(
      shortOfCarbs,
      1900,
      balanced,
      [{ mealId: 'breakfast', meal: 'breakfast', dish: PLATE }],
      ALL,
      anyone,
    )!;
    expect(picked.key).toBe('rye_bread');
  });

  it('keeps a sweet porridge sweet', () => {
    const picked = bestTopping(
      shortOfProtein,
      2800,
      highProtein,
      [{ mealId: 'breakfast', meal: 'breakfast', dish: PORRIDGE }],
      ALL,
      anyone,
    )!;
    expect(['sweet', 'both']).toContain(topping(picked.key).taste);
  });

  it('gives a place a model named a topping for that topping alone, and only where it passes', () => {
    // The engine's own pick is turkey; tofu brings the day nearer too.
    expect(
      bestTopping(
        shortOfProtein,
        2800,
        highProtein,
        [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }],
        ALL,
        anyone,
      )!.key,
    ).toBe('turkey');
    const named = bestTopping(
      shortOfProtein,
      2800,
      highProtein,
      [{ mealId: 'lunch', meal: 'lunch', dish: PLATE, only: 'tofu' }],
      ALL,
      anyone,
    )!;
    expect(named.key).toBe('tofu');
    // Yogurt does not go on a savoury plate; chickpeas, mostly carbohydrate, bring a day short of protein no nearer.
    for (const only of ['greek_yogurt', 'chickpeas'])
      expect(
        bestTopping(
          shortOfProtein,
          2800,
          highProtein,
          [{ mealId: 'lunch', meal: 'lunch', dish: PLATE, only }],
          ALL,
          anyone,
        ),
      ).toBeNull();
  });

  it('of those that bring the day back onto its split, takes the one the person had least of late, then the nearest', () => {
    // Just off its split: turkey, tofu and an egg each bring it back, turkey nearest, then tofu.
    const nearly: Figures = { calories: 2800, protein: 158, fat: 98, carbs: 321.5 };
    expect(shares(nearly, highProtein)).toBeGreaterThan(MACROS_OFF);
    const place: ToppingPlace[] = [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }];
    const pick = (used: [string, number][]) =>
      bestTopping(nearly, 2800, highProtein, place, ALL, anyone, new Map(used))!;

    expect(pick([]).key).toBe('turkey');
    expect(pick([['turkey', 1]]).key).toBe('tofu');
    expect(
      pick([
        ['turkey', 1],
        ['tofu', 1],
      ]).key,
    ).toBe('egg');
    // Each had as often: the nearest again.
    expect(
      pick([
        ['turkey', 2],
        ['tofu', 2],
        ['egg', 2],
      ]).key,
    ).toBe('turkey');
    for (const used of [
      [],
      [['turkey', 1]],
      [
        ['turkey', 1],
        ['tofu', 1],
      ],
    ] as [string, number][][]) {
      expect(shares(after(nearly, 2800, pick(used)), highProtein)).toBeLessThanOrEqual(MACROS_OFF);
    }
  });

  it('in a plan that wastes less, takes from what the packs would leave first, and opens a pack that would be left only where nothing else brings the day back', () => {
    const nearly: Figures = { calories: 2800, protein: 158, fat: 98, carbs: 321.5 };
    const place: ToppingPlace[] = [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }];
    const pick = (leaves: Record<string, number>, used: [string, number][] = []) =>
      bestTopping(
        nearly,
        2800,
        highProtein,
        place,
        ALL,
        anyone,
        new Map(used),
        (one) => leaves[one.topping.key] ?? 0,
      )!;

    // Turkey and tofu would open packs and leave most of them: the egg, which keeps, comes first.
    expect(pick({ turkey: 0.8, tofu: 0.5 }).key).toBe('egg');
    // Turkey from a pack the kitchen would otherwise leave comes first, however often it was had of late.
    expect(pick({ turkey: -0.3, tofu: 0.5 }, [['turkey', 2]]).key).toBe('turkey');
    // Where every one that brings the day back leaves more, one is still given: the nearest.
    expect(pick({ turkey: 0.8, tofu: 0.5, egg: 0.2 }).key).toBe('turkey');
  });

  it('keeps the one topping that brings the day back, however often the person had it', () => {
    // Far off its split: turkey alone brings it back.
    expect(
      bestTopping(
        shortOfProtein,
        2800,
        highProtein,
        [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }],
        ALL,
        anyone,
        new Map([['turkey', 6]]),
      )!.key,
    ).toBe('turkey');
  });

  it('gives nothing to a day on its split and within a tenth of its target, or with no plate to put it on', () => {
    // 5 % under its target, on its split: a topping could bring it nearer, and it needs none.
    const onTarget: Figures = { calories: 1800, protein: 90, fat: 60, carbs: 225 };
    expect(
      bestTopping(
        onTarget,
        1900,
        balanced,
        [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }],
        ALL,
        anyone,
      ),
    ).toBeNull();
    expect(bestTopping(shortOfCarbs, 1900, balanced, [], ALL, anyone)).toBeNull();
  });

  it('brings a day short of its calories nearer them without leaving its split', () => {
    // On its split but heavy in carbohydrate: rice, the nearest to the calories it lacks, would take it off the split.
    const short: Figures = { calories: 1500, protein: 60, fat: 40, carbs: 225 };
    const picked = bestTopping(
      short,
      1900,
      balanced,
      [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }],
      ALL,
      anyone,
    )!;
    const per100 = option(picked.key).per100;
    const held = {
      protein: short.protein + (per100.protein * picked.amount) / 100,
      fat: short.fat + (per100.fat * picked.amount) / 100,
      carbs: short.carbs + (per100.carbs * picked.amount) / 100,
    };
    expect(short.calories + (per100.calories * picked.amount) / 100).toBeGreaterThan(
      short.calories + 0.01 * 1900,
    );
    expect(shares(held, balanced)).toBeLessThanOrEqual(MACROS_OFF);
  });
});
