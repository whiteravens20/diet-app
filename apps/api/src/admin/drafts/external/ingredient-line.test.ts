// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { parseIngredientLine } from './ingredient-line.js';

const read = (text: string) => {
  const parsed = parseIngredientLine(text);
  return parsed.ok
    ? `${parsed.line.quantity} ${parsed.line.unit} | ${parsed.line.name}`
    : parsed.problem;
};

describe("a line of a recipe's ingredient list", () => {
  it.each([
    ['200 g rolled oats', '200 g | rolled oats'],
    ['200g rolled oats', '200 g | rolled oats'],
    ['1.5 kg potatoes', '1500 g | potatoes'],
    ['1,5 kg potatoes', '1500 g | potatoes'],
    ['250 ml whole milk', '250 ml | whole milk'],
    ['1 l water', '1000 ml | water'],
    ['2 tbsp olive oil', '30 ml | olive oil'],
    ['1 tsp. ground cinnamon', '5 ml | ground cinnamon'],
    ['1 cup of rolled oats', '240 ml | rolled oats'],
    ['4 oz cheddar', '113.4 g | cheddar'],
    ['1 lb chicken breast', '453.6 g | chicken breast'],
    ['2 fl oz lemon juice', '59.1 ml | lemon juice'],
    ['3 pieces of dark chocolate', '3 piece | dark chocolate'],
  ])('%s is an amount in grams, millilitres or pieces, and a name', (line, expected) => {
    expect(read(line)).toBe(expected);
  });

  it.each([
    ['2 eggs', '2 piece | eggs'],
    ['2 large eggs, beaten', '2 piece | large eggs'],
    ['1 lemon', '1 piece | lemon'],
    ['1 onion (about 150 g), finely chopped', '1 piece | onion'],
  ])('%s without a unit is so many pieces', (line, expected) => {
    expect(read(line)).toBe(expected);
  });

  it.each([
    ['1/2 cup milk', '120 ml | milk'],
    ['1 1/2 cups milk', '360 ml | milk'],
    ['½ tsp salt', '2.5 ml | salt'],
    ['1 ½ cups flour', '360 ml | flour'],
    ['¾ cup sugar', '180 ml | sugar'],
  ])('%s reads its fraction', (line, expected) => {
    expect(read(line)).toBe(expected);
  });

  it('is read whatever stands before it and however it is spaced', () => {
    expect(read('  -  200   g   rolled oats ')).toBe('200 g | rolled oats');
    expect(read('• 2 eggs')).toBe('2 piece | eggs');
  });

  it.each([
    ['salt to taste', 'no-quantity'],
    ['a pinch of salt', 'no-quantity'],
    ['olive oil, for frying', 'no-quantity'],
    ['0 g sugar', 'no-quantity'],
    ['2-3 apples', 'range-for-quantity'],
    ['2 – 3 tbsp honey', 'range-for-quantity'],
    ['2 to 3 carrots', 'range-for-quantity'],
    ['2 cloves garlic', 'unknown-unit'],
    ['1 can chickpeas', 'unknown-unit'],
    ['1 pinch salt', 'unknown-unit'],
    ['1 bunch parsley', 'unknown-unit'],
    ['200 g', 'no-name'],
    ['2 , chopped', 'no-name'],
  ])('%s is refused: %s', (line, problem) => {
    expect(read(line)).toBe(problem);
  });

  it('takes a unit only where it ends: the l of a lemon is none', () => {
    expect(read('1 lime')).toBe('1 piece | lime');
    expect(read('2 grapefruit')).toBe('2 piece | grapefruit');
    expect(read('1 cupcake')).toBe('1 piece | cupcake');
  });
});
