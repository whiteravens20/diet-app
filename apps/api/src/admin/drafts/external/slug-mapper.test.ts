// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { plainName, slugMapper } from './slug-mapper.js';

const catalogue = [
  { slug: 'rolled-oats', names: ['Rolled oats'] },
  { slug: 'whole-milk', names: ['Whole milk'] },
  { slug: 'egg', names: ['Egg'] },
  { slug: 'tomato', names: ['Tomato'] },
  { slug: 'apricot', names: ['Apricot'] },
  { slug: 'dried-apricot', names: ['Dried apricots'] },
  { slug: 'wheat-flour', names: ['Wheat flour'] },
  { slug: 'olive-oil', names: ['Olive oil', 'Extra virgin olive oil'] },
  { slug: 'blueberries', names: ['Blueberries'] },
];
const aliases = {
  'all-purpose flour': 'wheat-flour',
  'plain flour': 'wheat-flour',
  scallion: 'spring-onion',
  'oat flakes': 'rolled-oats',
};
const slugOf = slugMapper(catalogue, aliases);

describe('which ingredient of the catalogue a name means', () => {
  it.each([
    ['rolled oats', 'rolled-oats'],
    ['Rolled Oats', 'rolled-oats'],
    ['eggs', 'egg'],
    ['large eggs', 'egg'],
    ['tomatoes', 'tomato'],
    ['ripe tomatoes', 'tomato'],
    ['finely chopped tomato', 'tomato'],
    ['fresh blueberries', 'blueberries'],
    ['blueberry', 'blueberries'],
    ['whole milk', 'whole-milk'],
    ['extra-virgin olive oil', 'olive-oil'],
  ])('%s is %s', (name, slug) => {
    expect(slugOf(name)).toBe(slug);
  });

  it("is said by the catalogue's slug too, and by an alias the operator keeps", () => {
    expect(slugOf('wheat flour')).toBe('wheat-flour');
    expect(slugOf('all-purpose flour')).toBe('wheat-flour');
    expect(slugOf('Plain Flour')).toBe('wheat-flour');
    expect(slugOf('oat flakes')).toBe('rolled-oats');
  });

  it('keeps the words that change what a hundred grams hold: dried apricots are not apricots', () => {
    expect(slugOf('dried apricots')).toBe('dried-apricot');
    expect(slugOf('apricots')).toBe('apricot');
    expect(slugOf('milk')).toBeNull();
    expect(slugOf('ground oats')).toBeNull();
    expect(slugOf('smoked tomato')).toBeNull();
  });

  it('is nobody when the catalogue has nothing by that name, however alike another is', () => {
    expect(slugOf('rolled oat bran')).toBeNull();
    expect(slugOf('tomatillo')).toBeNull();
    expect(slugOf('')).toBeNull();
  });

  it('takes no alias that points at an ingredient the catalogue does not have', () => {
    expect(slugOf('scallion')).toBeNull();
  });

  it('names neither of two ingredients that go by the same plain name', () => {
    const twice = slugMapper(
      [
        { slug: 'pepper-black', names: ['Pepper'] },
        { slug: 'bell-pepper', names: ['Peppers'] },
      ],
      {},
    );

    expect(twice('pepper')).toBeNull();
    expect(twice('bell pepper')).toBe('bell-pepper');
  });

  it("lets an alias decide where the catalogue's own names would name another", () => {
    const decided = slugMapper(catalogue, { apricots: 'dried-apricot' });

    expect(decided('apricots')).toBe('dried-apricot');
  });
});

describe('the plain form a name is compared in', () => {
  it('is lower case, one of a thing, without how it is cut or how big it is', () => {
    expect(plainName('2 Large  Free-Range Eggs')).toBe('2 free range egg');
    expect(plainName('Tomatoes, finely chopped')).toBe('tomato');
    expect(plainName('Swiss  chard')).toBe('swiss chard');
    expect(plainName('asparagus')).toBe('asparagus');
  });

  it('need not be a word, only the same for the same thing: both sides of a comparison are brought to it', () => {
    expect(plainName('Molasses')).toBe(plainName('molasses'));
    expect(plainName('Hummus')).toBe('hummus');
    expect(plainName('Swiss cheeses')).toBe(plainName('swiss cheese'));
  });
});
