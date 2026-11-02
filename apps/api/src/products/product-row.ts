// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { type Product, type ProductUnit } from '@diet-app/shared';
import { foldedProductText, productCodeOf } from '@diet-app/shared/product-code';
import { readLabel, type LabelFigures, type LabelReading } from '../engine/index.js';
import { PRODUCT_TEXT_LIMITS } from './limits.js';

/** A product as the instance keeps it, from either way Open Food Facts gives it. */
export interface ProductRow extends LabelFigures {
  code: string;
  name: string;
  brand: string | null;
  searchText: string;
  pack: string | null;
  unit: ProductUnit;
  packAmount: number | null;
  servingAmount: number | null;
  changedAt: string | null;
  popularity: number;
}

/** What Open Food Facts says of a product, whichever way it says it. */
export interface ProductFields {
  code: string;
  name: string;
  brands: string;
  quantity: string;
  packAmount: number | null;
  servingAmount: number | null;
  /** What its figures are given in, where that is said. */
  per: ProductUnit | null;
  reading: LabelReading;
  /** Seconds since 1970. */
  changedAt: number | null;
  scans: number | null;
}

/** The most of one product a pack or a serving is taken to hold; beyond it a number is a slip, or a pallet. */
const MOST_AMOUNT = 100_000;

/** What stands between a name and a brand in what a search reads: no text it folds can hold it. */
export const SEARCH_TEXT_PARTS = ' | ';

/** The earliest and the latest a change of a product can be dated, in seconds since 1970: Open Food Facts began in 2012. */
const EARLIEST_CHANGE = 1_300_000_000;
const LATEST_CHANGE = 4_000_000_000;

const WHAT_A_PACK_HOLDS = /(\d+(?:[.,]\d+)?)\s*(kg|mg|g|ml|cl|dl|l)\b/i;
const HOW_MANY_IN_A_PACK = /(\d+)\s*[x×*]\s*(?=\d)/i;

/** In the unit a product is measured in, how much of it one of these is. */
const IN_ITS_UNIT: Record<string, { unit: ProductUnit; times: number }> = {
  mg: { unit: 'g', times: 0.001 },
  g: { unit: 'g', times: 1 },
  kg: { unit: 'g', times: 1000 },
  ml: { unit: 'ml', times: 1 },
  cl: { unit: 'ml', times: 10 },
  dl: { unit: 'ml', times: 100 },
  l: { unit: 'ml', times: 1000 },
};

/** A text as it can be shown and kept: no control characters, which a database refuses as well, one space between words, at most `most` signs. */
export function cleanText(text: string, most: number): string {
  const clean = text.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, most).join('').trim();
}

/** What a pack holds by the words of its label, and what that is measured in. */
function packFromWords(quantity: string): { amount: number | null; unit: ProductUnit | null } {
  const holds = WHAT_A_PACK_HOLDS.exec(quantity);
  const measure = holds && IN_ITS_UNIT[holds[2]!.toLowerCase()];
  if (!holds || !measure) return { amount: null, unit: null };
  const many = HOW_MANY_IN_A_PACK.exec(quantity);
  const amount = Number(holds[1]!.replace(',', '.')) * measure.times * (many ? Number(many[1]) : 1);
  return { amount, unit: measure.unit };
}

const positive = (value: number | null): number | null =>
  value !== null && value > 0 && value <= MOST_AMOUNT ? Math.round(value * 100) / 100 : null;

/** The first brands a product names, as they are read, without the one that is its name already. */
function brandOf(brands: string, name: string): string | null {
  const named = brands
    .split(',')
    .map((brand) => cleanText(brand, PRODUCT_TEXT_LIMITS.brand))
    .filter((brand) => brand !== '' && foldedProductText(brand) !== foldedProductText(name))
    .slice(0, 2)
    .join(', ');
  return named === '' ? null : [...named].slice(0, PRODUCT_TEXT_LIMITS.brand).join('');
}

/**
 * What the instance keeps of a product, or why it keeps nothing: a code that
 * is no barcode, or no name to show it by. What it says of its figures is
 * read the same way wherever it comes from.
 */
export function productRowOf(fields: ProductFields): ProductRow | 'code' | 'name' {
  const code = productCodeOf(fields.code);
  if (code === null) return 'code';
  const name = cleanText(fields.name, PRODUCT_TEXT_LIMITS.name);
  // A dot is no name, and neither is anything else without a letter or a digit.
  if (foldedProductText(name) === '') return 'name';
  const brand = brandOf(fields.brands, name);
  const words = packFromWords(fields.quantity);
  const unit = fields.per ?? words.unit ?? 'g';
  const pack = cleanText(fields.quantity, PRODUCT_TEXT_LIMITS.pack);
  const changed =
    fields.changedAt !== null &&
    fields.changedAt >= EARLIEST_CHANGE &&
    fields.changedAt <= LATEST_CHANGE
      ? new Date(fields.changedAt * 1000).toISOString()
      : null;
  return {
    code,
    name,
    brand,
    searchText: brand
      ? `${foldedProductText(name)}${SEARCH_TEXT_PARTS}${foldedProductText(brand)}`
      : foldedProductText(name),
    pack: pack === '' ? null : pack,
    unit,
    packAmount: positive(fields.packAmount) ?? positive(words.amount),
    servingAmount: positive(fields.servingAmount),
    changedAt: changed,
    popularity:
      fields.scans !== null && fields.scans > 0
        ? Math.min(Math.floor(fields.scans), 2 ** 31 - 1)
        : 0,
    ...readLabel(fields.reading),
  };
}

/** A product as the database holds it, as far as an answer needs it. */
export interface HeldProduct {
  id: string;
  code: string;
  name: string;
  brand: string | null;
  pack: string | null;
  unit: string;
  packAmount: number | null;
  servingAmount: number | null;
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fiber: number | null;
  sugars: number | null;
  salt: number | null;
  saturatedFat: number | null;
  energyWorkedOut: boolean;
  doubtful: boolean;
  changedAt: Date | null;
}

/** A product as an answer gives it. */
export function productDto(row: HeldProduct): Product {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    brand: row.brand,
    pack: row.pack,
    unit: row.unit as ProductUnit,
    packAmount: row.packAmount,
    servingAmount: row.servingAmount,
    per100: {
      calories: row.calories,
      protein: row.protein,
      fat: row.fat,
      carbs: row.carbs,
      fiber: row.fiber,
      sugars: row.sugars,
      salt: row.salt,
      saturatedFat: row.saturatedFat,
    },
    energyWorkedOut: row.energyWorkedOut,
    doubtful: row.doubtful,
    changedAt: row.changedAt?.toISOString() ?? null,
  };
}
