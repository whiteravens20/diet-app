// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { RebalanceMeal } from './rebalance.js';
import {
  PLATE_RANGE,
  WHOLE_PLATE,
  partOf,
  plateChange,
  plateDay,
  plateOf,
  withPlates,
  type PartFigures,
  type PartIngredient,
  type Plate,
  type PlateDish,
  type PlatePart,
} from './plates.js';

const ingredient = (
  slug: string,
  category: string,
  proteinKind: PartIngredient['proteinKind'] = null,
): PartIngredient => ({
  slug,
  name: slug,
  category,
  proteinKind,
});

describe('the part of a dish an ingredient is', () => {
  it('is the protein for a kind of protein other than dairy, the starch for a starch, and the vegetables', () => {
    expect(partOf(ingredient('chicken-breast', 'meat', 'chicken'))).toBe('protein');
    expect(partOf(ingredient('salmon-fillet', 'fish', 'fish'))).toBe('protein');
    expect(partOf(ingredient('large-egg', 'dairy', 'eggs'))).toBe('protein');
    expect(partOf(ingredient('tofu', 'legumes', 'legumes'))).toBe('protein');
    expect(partOf(ingredient('white-rice', 'grains'))).toBe('starch');
    expect(partOf(ingredient('whole-wheat-pasta', 'grains'))).toBe('starch');
    expect(partOf(ingredient('broccoli', 'vegetables'))).toBe('vegetables');
  });

  it('is the starch for a potato though it is a vegetable, and the rest for fat, sauce, spice and cheese', () => {
    expect(partOf(ingredient('potato', 'vegetables'))).toBe('starch');
    expect(partOf(ingredient('olive-oil', 'fats_oils'))).toBe('rest');
    expect(partOf(ingredient('soy-sauce', 'spices'))).toBe('rest');
    expect(partOf(ingredient('feta-cheese', 'dairy', 'dairy'))).toBe('rest');
    // Rice vinegar is no rice.
    expect(partOf(ingredient('rice-vinegar', 'spices'))).toBe('rest');
  });
});

/** Figures of a part from its grams of each macronutrient. */
const part = (protein: number, fat: number, carbs: number): PartFigures => ({
  protein,
  fat,
  carbs,
  calories: protein * 4 + fat * 9 + carbs * 4,
});
const none = part(0, 0, 0);
/** Chicken, rice and broccoli for one person, a little oil: about 690 kcal. */
const dish = (): Record<PlatePart, PartFigures> => ({
  protein: part(50, 6, 0),
  starch: part(6, 1, 70),
  vegetables: part(5, 1, 10),
  rest: part(0, 5, 0),
});
const energyOf = (parts: Record<PlatePart, PartFigures>, plate: Plate): number =>
  parts.protein.calories * plate.protein +
  parts.starch.calories * plate.starch +
  parts.vegetables.calories * plate.vegetables +
  parts.rest.calories;

describe('a person’s plate of a shared dish', () => {
  it('holds more protein for a day short of it and less starch, its energy kept', () => {
    // The rest of the day is carbohydrate-heavy; the aim is a high-protein split.
    const input = {
      parts: dish(),
      day: { protein: 60, fat: 50, carbs: 250 },
      aim: { protein: 0.35, fat: 0.3, carbs: 0.35 },
      dietType: 'high_protein',
    };
    const plate = plateOf(input);

    expect(plate.protein).toBeGreaterThan(1);
    expect(plate.starch).toBeLessThan(1);
    expect(energyOf(input.parts, plate)).toBeCloseTo(energyOf(input.parts, WHOLE_PLATE), 0);
    for (const share of Object.values(plate)) {
      expect(share).toBeGreaterThanOrEqual(PLATE_RANGE.least);
      expect(share).toBeLessThanOrEqual(PLATE_RANGE.most);
    }
  });

  it('holds more starch for a day short of carbohydrate', () => {
    const plate = plateOf({
      parts: dish(),
      day: { protein: 120, fat: 40, carbs: 80 },
      aim: { protein: 0.25, fat: 0.3, carbs: 0.45 },
      dietType: 'balanced',
    });

    expect(plate.starch).toBeGreaterThan(1);
    expect(plate.protein).toBeLessThan(1);
  });

  it('stays the recipe’s where the day is on its split, or a plate brings it no nearer worth the name', () => {
    // A day of 2400 kcal that, with the dish as it is, sits on its split: 150 g of protein, 80 of fat, 270 of carbohydrate.
    const parts = dish();
    const day = { protein: 150 - 61, fat: 80 - 13, carbs: 270 - 80 };
    expect(
      plateOf({ parts, day, aim: { protein: 0.25, fat: 0.3, carbs: 0.45 }, dietType: 'balanced' }),
    ).toEqual(WHOLE_PLATE);
  });

  it('stays the recipe’s for a dish with fewer than two parts that can move, and keeps a missing part at one', () => {
    const onlyProtein = { ...dish(), starch: none, vegetables: none };
    expect(
      plateOf({
        parts: onlyProtein,
        day: { protein: 60, fat: 50, carbs: 250 },
        aim: { protein: 0.35, fat: 0.3, carbs: 0.35 },
        dietType: 'high_protein',
      }),
    ).toEqual(WHOLE_PLATE);

    // Without vegetables, protein and starch trade places: the vegetables stay at one.
    const noVegetables = { ...dish(), vegetables: none };
    const plate = plateOf({
      parts: noVegetables,
      day: { protein: 60, fat: 50, carbs: 250 },
      aim: { protein: 0.35, fat: 0.3, carbs: 0.35 },
      dietType: 'high_protein',
    });
    expect(plate.vegetables).toBe(1);
    expect(plate.protein).toBeGreaterThan(1);
    expect(energyOf(noVegetables, plate)).toBeCloseTo(energyOf(noVegetables, WHOLE_PLATE), 0);
  });
});

/** The dish as a serving of it holds its parts, with a little fibre and salt, and the part of each ingredient. */
const DISH: PlateDish = {
  parts: dish(),
  labels: {
    protein: { fiber: 0, sugars: 0, salt: 0.2, saturatedFat: 1.5 },
    starch: { fiber: 1, sugars: 0.5, salt: 0, saturatedFat: 0.2 },
    vegetables: { fiber: 4, sugars: 2, salt: 0.05, saturatedFat: 0 },
    rest: { fiber: 0, sugars: 0, salt: 0.6, saturatedFat: 0.7 },
  },
  partOf: new Map<string, PlatePart>([
    ['chicken', 'protein'],
    ['rice', 'starch'],
    ['broccoli', 'vegetables'],
    ['oil', 'rest'],
  ]),
};
const row = (id: string, calories: number, macros: RebalanceMeal['macros']): RebalanceMeal => ({
  id,
  calories,
  servings: 1,
  quantityScale: 1,
  locked: false,
  ...(macros ? { macros } : {}),
});
/** The dish as its recipe has it: what its parts add up to. */
const LUNCH = row('lunch', 681, { protein: 61, fat: 13, carbs: 80 });
/** A breakfast of porridge, heavy on carbohydrate. */
const BREAKFAST = row('breakfast', 900, { protein: 25, fat: 20, carbs: 155 });
/** A high-protein day of 2,000 kcal, in grams. */
const HIGH_PROTEIN = { protein: 175, fat: 67, carbs: 175 };

describe('what a plate changes of a serving', () => {
  it('is each part moved by its share, its energy kept and the rest as it is', () => {
    const plate: Plate = { protein: 1.2, starch: 0.85, vegetables: 1 };
    const { perServing, labelPerServing } = plateChange(DISH, plate);

    expect(perServing.protein).toBeCloseTo(0.2 * 50 - 0.15 * 6, 6);
    expect(perServing.carbs).toBeCloseTo(-0.15 * 70, 6);
    expect(labelPerServing.fiber).toBeCloseTo(-0.15 * 1, 6);
    expect(labelPerServing.saturatedFat).toBeCloseTo(0.2 * 1.5 - 0.15 * 0.2, 6);
    expect(plateChange(DISH, WHOLE_PLATE)).toEqual({
      perServing: { calories: 0, protein: 0, fat: 0, carbs: 0 },
      labelPerServing: { fiber: 0, sugars: 0, salt: 0, saturatedFat: 0 },
    });
  });
});

describe('the plates of a day', () => {
  it('give a shared dish the plate that brings the day nearest its split, the rest of the day as it is', () => {
    const plates = plateDay(
      [BREAKFAST, LUNCH],
      new Map(),
      [{ mealId: 'lunch', dish: DISH }],
      HIGH_PROTEIN,
      'high_protein',
    );
    const plate = plates.get('lunch')!;

    expect(plate.protein).toBeGreaterThan(1);
    expect(plate.starch).toBeLessThan(1);
    expect(energyOf(DISH.parts, plate)).toBeCloseTo(energyOf(DISH.parts, WHOLE_PLATE), 0);
    // The day with the plate is nearer its split than with the recipe's proportions.
    const [, plated] = withPlates([BREAKFAST, LUNCH], plates, new Map([['lunch', { dish: DISH }]]));
    expect(plated!.macros!.protein).toBeGreaterThan(LUNCH.macros!.protein);
    expect(plated!.calories).toBeCloseTo(LUNCH.calories, 0);
  });

  it('size a plate to the portion the person has, and count the meals plated before it', () => {
    const half = plateDay(
      [BREAKFAST, LUNCH],
      new Map([['lunch', 0.5]]),
      [{ mealId: 'lunch', dish: DISH }],
      HIGH_PROTEIN,
      'high_protein',
    ).get('lunch')!;
    const whole = plateDay(
      [BREAKFAST, LUNCH],
      new Map(),
      [{ mealId: 'lunch', dish: DISH }],
      HIGH_PROTEIN,
      'high_protein',
    ).get('lunch')!;
    // Half a portion moves the day less, so it is moved further.
    expect(half.protein).toBeGreaterThanOrEqual(whole.protein);

    // Two shared dishes the same day: the second sees the first on its plate, and needs less of a change.
    const dinner = { ...LUNCH, id: 'dinner' };
    const two = plateDay(
      [BREAKFAST, LUNCH, dinner],
      new Map(),
      [
        { mealId: 'lunch', dish: DISH },
        { mealId: 'dinner', dish: DISH },
      ],
      { protein: 205, fat: 78, carbs: 205 },
      'high_protein',
    );
    expect(two.get('lunch')!.protein).toBeGreaterThan(1);
    expect(two.get('dinner')?.protein ?? 1).toBeLessThanOrEqual(two.get('lunch')!.protein);
  });

  it('leave out a dish whose plate stays the recipe’s, and keep the plate a dish has where no other is worth the change', () => {
    // A day on its split: nothing to move.
    const onSplit = row('breakfast', 1349, { protein: 114, fat: 54, carbs: 95 });
    expect(
      plateDay(
        [onSplit, LUNCH],
        new Map(),
        [{ mealId: 'lunch', dish: DISH }],
        HIGH_PROTEIN,
        'high_protein',
      ).size,
    ).toBe(0);

    // A plate chosen for a day, asked again of the day a little richer in protein: another would be chosen
    // afresh, but brings the day hardly nearer, and the plate the dish has stays.
    const lunch = [{ mealId: 'lunch', dish: DISH }];
    const breakfast = (protein: number) =>
      row('breakfast', protein * 4 + 54 * 9 + 130 * 4, { protein, fat: 54, carbs: 130 });
    const plateOn = (protein: number, now?: Plate) =>
      plateDay(
        [breakfast(protein), LUNCH],
        new Map(),
        lunch.map((place) => ({ ...place, now: now ?? null })),
        HIGH_PROTEIN,
        'high_protein',
      ).get('lunch');
    const now = plateOn(100)!;
    expect(plateOn(102)).not.toEqual(now);
    expect(plateOn(102, now)).toEqual(now);
    // A day that moved more takes the plate chosen afresh.
    expect(plateOn(110, now)).toEqual(plateOn(110));
    expect(plateOn(110)).not.toEqual(now);
  });
});
