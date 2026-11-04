// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { LabelReading } from '../engine/index.js';
import { figureOf } from './open-food-facts.js';
import { cleanText, productRowOf, type ProductFields, type ProductRow } from './product-row.js';

const NOTHING: LabelReading = {
  kcal: null,
  kj: null,
  protein: null,
  fat: null,
  carbs: null,
  fiber: null,
  sugars: null,
  salt: null,
  sodium: null,
  saturatedFat: null,
  alcohol: null,
  polyols: null,
};

const fields = (given: Partial<ProductFields>): ProductFields => ({
  code: '5900512320359',
  name: 'Mleko',
  brands: '',
  quantity: '',
  packAmount: null,
  servingAmount: null,
  per: null,
  reading: NOTHING,
  changedAt: null,
  scans: null,
  ...given,
});

const rowOf = (given: Partial<ProductFields>): ProductRow =>
  productRowOf(fields(given)) as ProductRow;

describe('what the instance keeps of a product', () => {
  it('nothing of a code that is no barcode, and says so', () => {
    expect(productRowOf(fields({ code: '123' }))).toBe('code');
    expect(productRowOf(fields({ code: '5900512320358' }))).toBe('code');
  });

  it('nothing of a product without a name to show it by, and says so', () => {
    expect(productRowOf(fields({ name: '  \t ' }))).toBe('name');
  });

  it.each(['.', '-', '...', '?!'])('nothing of a product called %s, which is no name', (name) => {
    expect(productRowOf(fields({ name }))).toBe('name');
  });

  it('a code in the form Open Food Facts keeps it', () => {
    expect(rowOf({ code: '036000291452' }).code).toBe('0036000291452');
  });

  it.each([
    ['500 g', 500, 'g'],
    ['1 kg', 1000, 'g'],
    ['1l', 1000, 'ml'],
    ['0,5 L', 500, 'ml'],
    ['33 cl', 330, 'ml'],
    ['2 dl', 200, 'ml'],
    ['6 x 1,5 l', 9000, 'ml'],
    ['4x125g', 500, 'g'],
    ['500 mg', 0.5, 'g'],
  ])('what a pack of %s holds, and what it is measured in', (quantity, packAmount, unit) => {
    expect(rowOf({ quantity })).toMatchObject({ pack: quantity, packAmount, unit });
  });

  it('a pack in other words as they are, without an amount', () => {
    expect(rowOf({ quantity: 'duży słoik' })).toMatchObject({
      pack: 'duży słoik',
      packAmount: null,
      unit: 'g',
    });
  });

  it('what the source says of its figures before what a pack says', () => {
    expect(rowOf({ quantity: '1 kg', per: 'ml' }).unit).toBe('ml');
  });

  it('the number the source gives for a pack before what its words come to', () => {
    expect(rowOf({ quantity: 'około 1 kg', packAmount: 980 }).packAmount).toBe(980);
  });

  it.each([
    ['nothing', 0],
    ['below nothing', -30],
    ['a pallet', 500_000],
  ])('no serving of %s', (_, servingAmount) => {
    expect(rowOf({ servingAmount }).servingAmount).toBeNull();
  });

  it('the first two brands of those it names', () => {
    expect(rowOf({ brands: 'Lidl, Milbona,,Inna' }).brand).toBe('Lidl, Milbona');
  });

  it('no brand that is its name already', () => {
    expect(rowOf({ name: 'Nutella', brands: 'nutella, Ferrero' }).brand).toBe('Ferrero');
    expect(rowOf({ name: 'Żubr', brands: 'ŻUBR' }).brand).toBeNull();
  });

  it('a name it can show, however it comes', () => {
    expect(rowOf({ name: 'Ser\u0000\tżółty\n ‮gouda' }).name).toBe('Ser żółty gouda');
    expect([...rowOf({ name: 'x'.repeat(500) }).name]).toHaveLength(160);
  });

  it('no date of a change that cannot be one', () => {
    expect(rowOf({ changedAt: 12 }).changedAt).toBeNull();
    expect(rowOf({ changedAt: 1787927571 }).changedAt).toBe('2026-08-28T14:32:51.000Z');
  });

  it('how many people scanned it, within what the column holds', () => {
    expect(rowOf({ scans: 12.5 }).popularity).toBe(12);
    expect(rowOf({ scans: -1 }).popularity).toBe(0);
    expect(rowOf({ scans: 2 ** 40 }).popularity).toBe(2 ** 31 - 1);
  });

  it('what a search reads, from its name and brand', () => {
    expect(rowOf({ name: 'Mleko ŁACIATE 3,2%', brands: 'Mlekpol' }).searchText).toBe(
      'mleko laciate 3 2 | mlekpol',
    );
  });
});

describe('a number in a column of the export or a field of an answer', () => {
  it.each([
    ['12', 12],
    ['12.5', 12.5],
    ['-3', -3],
    ['1e2', 100],
    [' 7 ', 7],
    [4, 4],
  ])('%s is read', (given, read) => {
    expect(figureOf(given)).toBe(read);
  });

  it.each([[''], ['abc'], ['0x10'], ['1,5'], ['1e999'], [null], [undefined], [Number.NaN], [{}]])(
    '%s is none',
    (given) => {
      expect(figureOf(given)).toBeNull();
    },
  );
});

describe('a text to show', () => {
  it('holds no control character, which a database would refuse', () => {
    expect(cleanText('a\u0000b', 10)).toBe('a b');
    expect(cleanText('a​b﻿c', 10)).toBe('a b c');
  });

  it('never cuts a sign in two', () => {
    expect(cleanText('😀😀😀', 2)).toBe('😀😀');
  });
});
