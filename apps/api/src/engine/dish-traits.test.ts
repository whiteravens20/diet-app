// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it, vi } from 'vitest';
import { proposeTraits, traitsOf, type TraitsIngredient, type TraitsLine } from './dish-traits.js';

const food = (slug: string, category: string, caloriesPer100: number): TraitsIngredient => ({
  slug,
  name: slug.replaceAll('-', ' '),
  category,
  caloriesPer100,
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
});

const OATS = food('rolled-oats', 'grains', 379);
const BREAD = food('whole-grain-bread', 'grains', 247);
const BUCKWHEAT = food('buckwheat-groats', 'grains', 346);
const FLOUR = food('flour-bread-white-enriched-unbleached', 'grains', 363);
const RICE_VINEGAR = food('rice-vinegar', 'pantry', 18);
const OAT_MILK = food('oat-milk-unsweetened-plain-refrigerated', 'beverages', 48);
const EGG = food('large-egg', 'dairy', 143);
const FETA = food('feta-cheese', 'dairy', 264);
const TOMATO = food('tomato', 'vegetables', 18);
const AVOCADO = food('avocado', 'fruits', 160);
const STRAWBERRIES = food('strawberries', 'fruits', 32);
const BLUEBERRIES = food('blueberries', 'fruits', 57);
const BANANA = food('banana', 'fruits', 89);
const HONEY = food('honey', 'pantry', 304);
const MILK = food('whole-milk', 'dairy', 61);
const PORK = food('pork-tenderloin', 'meat', 143);
const CHICKPEAS = food('chickpeas', 'legumes', 139);
const CUCUMBER = food('cucumber', 'vegetables', 15);
const PUMPKIN = food('pumpkin', 'vegetables', 26);
const TUNA = food('canned-tuna', 'fish', 86);
const CURD = food('curd-cheese', 'dairy', 132);
const ZUCCHINI = food('zucchini', 'vegetables', 17);
const YOGURT = food('greek-yogurt', 'dairy', 59);
const DILL = food('dill', 'spices', 43);
const PEPITAS = food('seeds-pumpkin-seeds-pepitas-raw', 'nuts_seeds', 574);
const MARINARA = food('sauce-pasta-spaghetti-marinara-ready-to-serve', 'pantry', 51);
const ONION_RINGS = food(
  'onion-rings-breaded-par-fried-frozen-prepared-heated-in-oven',
  'vegetables',
  276,
);
const OAT_COOKIES = food('cookies-oatmeal-soft-with-raisins', 'grains', 443);
const COCONUT_FLOUR = food('flour-coconut', 'nuts_seeds', 443);
const PITA = food('pita-bread-white', 'grains', 275);

const line = (ingredient: TraitsIngredient, quantity: number): TraitsLine => ({
  quantity,
  unit: 'g',
  ingredient,
});

describe('the traits a dish is proposed', () => {
  it('a porridge of oats with fruit and honey is sweet, a porridge, on groats', () => {
    expect(
      proposeTraits(
        ['Overnight oats with blueberries', 'Owsianka nocna z borówkami'],
        [line(OATS, 60), line(MILK, 180), line(BLUEBERRIES, 80), line(HONEY, 10)],
      ),
    ).toEqual({ taste: 'sweet', form: 'porridge_dessert', starchBase: 'groats' });
  });

  it('eggs on toast are a savoury sandwich on bread', () => {
    expect(
      proposeTraits(
        ['Scrambled eggs on whole-grain toast', 'Jajecznica na pełnoziarnistym toście'],
        [line(EGG, 120), line(BREAD, 70)],
      ),
    ).toEqual({ taste: 'savoury', form: 'sandwich', starchBase: 'bread' });
  });

  it('a toast or a salad served with the dish leaves it a plate', () => {
    expect(
      proposeTraits(
        [
          'Shakshuka with feta and whole-grain toast',
          'Szakszuka z fetą i grzanką z chleba pełnoziarnistego',
        ],
        [line(EGG, 120), line(TOMATO, 200), line(FETA, 30), line(BREAD, 60)],
      ),
    ).toEqual({ taste: 'savoury', form: 'plate', starchBase: 'bread' });
    expect(
      proposeTraits(
        [
          'Chickpea patties with tomato and cucumber salad',
          'Kotlety z ciecierzycy z sałatką z pomidora i ogórka',
        ],
        [line(CHICKPEAS, 150), line(TOMATO, 100), line(CUCUMBER, 100)],
      ).form,
    ).toBe('plate');
  });

  it('fruit beside an egg or an avocado is savoury', () => {
    expect(
      proposeTraits(
        [
          'Soft-boiled eggs with avocado and strawberries',
          'Jajka na miękko z awokado i truskawkami',
        ],
        [line(EGG, 120), line(AVOCADO, 70), line(STRAWBERRIES, 80)],
      ),
    ).toEqual({ taste: 'savoury', form: 'plate', starchBase: 'none' });
  });

  it('a starch is the base from a tenth of the energy, and a spoon of flour is not', () => {
    // 40 g of buckwheat (138 kcal) in about 1,060 kcal: 13 %.
    expect(
      proposeTraits(
        ['Pork tenderloin with buckwheat'],
        [line(PORK, 600), line(BUCKWHEAT, 40), line(ZUCCHINI, 400)],
      ).starchBase,
    ).toBe('groats');
    // 10 g of flour (36 kcal) in about 950 kcal: 4 %.
    expect(
      proposeTraits(['Pork stew'], [line(PORK, 600), line(FLOUR, 10), line(ZUCCHINI, 300)])
        .starchBase,
    ).toBe('none');
  });

  it('names its forms by Polish titles too', () => {
    expect(proposeTraits(['Zupa krem z dyni'], [line(PUMPKIN, 500)]).form).toBe('soup');
    expect(
      proposeTraits(['Sałatka z tuńczykiem'], [line(TUNA, 120), line(CUCUMBER, 100)]).form,
    ).toBe('salad');
    expect(proposeTraits(['Kanapki z twarogiem'], [line(BREAD, 70), line(CURD, 100)]).form).toBe(
      'sandwich',
    );
    expect(proposeTraits(['Grzanki z awokado'], [line(BREAD, 70), line(AVOCADO, 70)]).form).toBe(
      'sandwich',
    );
  });

  it('a vinegar or a milk named after a grain is no starch', () => {
    expect(
      proposeTraits(
        ['Cucumber with dressing'],
        [line(CUCUMBER, 300), line(RICE_VINEGAR, 30), line(OAT_MILK, 100)],
      ).starchBase,
    ).toBe('none');
  });

  it('nor are seeds, a sauce, a breaded vegetable, a cookie or a flour of nuts, whatever their names hold', () => {
    for (const named of [PEPITAS, MARINARA, ONION_RINGS, OAT_COOKIES, COCONUT_FLOUR]) {
      expect(
        proposeTraits(['Pork with a side'], [line(PORK, 300), line(named, 150)]).starchBase,
        named.slug!,
      ).toBe('none');
    }
    expect(proposeTraits(['Pork in a pita'], [line(PORK, 200), line(PITA, 80)]).starchBase).toBe(
      'bread',
    );
  });

  it('sweet pancakes are a dessert, savoury ones a plate', () => {
    expect(
      proposeTraits(
        ['Placki owsiane z bananem i borówkami'],
        [line(OATS, 60), line(BANANA, 120), line(BLUEBERRIES, 50)],
      ),
    ).toEqual({ taste: 'sweet', form: 'porridge_dessert', starchBase: 'groats' });
    expect(
      proposeTraits(['Placuszki z cukinii'], [line(ZUCCHINI, 300), line(EGG, 60), line(FLOUR, 40)])
        .form,
    ).toBe('plate');
  });

  it('a savoury dish whose title names a dessert is a plate, a porridge stays a porridge', () => {
    expect(
      proposeTraits(
        ['Jogurt z ogórkiem i koperkiem'],
        [line(YOGURT, 200), line(CUCUMBER, 150), line(DILL, 5)],
      ),
    ).toEqual({
      taste: 'savoury',
      form: 'plate',
      starchBase: 'none',
    });
    expect(proposeTraits(['Savoury oatmeal with egg'], [line(OATS, 60), line(EGG, 55)]).form).toBe(
      'porridge_dessert',
    );
  });
});

describe("a recipe's traits as read", () => {
  const proposed = { taste: 'savoury', form: 'plate', starchBase: 'rice' } as const;

  it('are those set on it, nothing proposed', () => {
    const propose = vi.fn(() => proposed);
    expect(
      traitsOf({ taste: 'sweet', form: 'porridge_dessert', starchBase: 'none' }, propose),
    ).toEqual({
      taste: 'sweet',
      form: 'porridge_dessert',
      starchBase: 'none',
    });
    expect(propose).not.toHaveBeenCalled();
  });

  it('take each one not set, or no longer known, from the proposal', () => {
    expect(traitsOf({ taste: null, form: 'soup', starchBase: null }, () => proposed)).toEqual({
      taste: 'savoury',
      form: 'soup',
      starchBase: 'rice',
    });
    expect(traitsOf({ taste: 'bitter', form: 'soup', starchBase: 'none' }, () => proposed)).toEqual(
      {
        taste: 'savoury',
        form: 'soup',
        starchBase: 'none',
      },
    );
  });
});
