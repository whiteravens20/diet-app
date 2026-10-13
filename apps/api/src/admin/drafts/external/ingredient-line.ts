// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Reading one line of a recipe's ingredient list as people write it:
 * "200 g rolled oats", "1 1/2 cups milk", "2 large eggs, beaten".
 *
 * What comes out is an amount in one of the catalogue's three units (grams,
 * millilitres, pieces) and the name of the thing, still as it was written:
 * which ingredient of the catalogue it is, is the mapper's to say.
 *
 * A line is read or it is refused. Nothing is guessed: a line without an
 * amount, with a range for one, or with a unit this file does not know has
 * no figure anybody could answer for.
 */

/** A line that was read. */
interface IngredientLine {
  quantity: number;
  unit: 'g' | 'ml' | 'piece';
  /** What the line names, without its amount and without what follows a comma or stands in brackets. */
  name: string;
}

export type LineProblem = 'no-quantity' | 'range-for-quantity' | 'unknown-unit' | 'no-name';

export type ParsedLine = { ok: true; line: IngredientLine } | { ok: false; problem: LineProblem };

/** What one of a unit is in the catalogue's unit of its kind. */
const UNITS: Record<string, { unit: 'g' | 'ml' | 'piece'; of: number }> = {
  g: { unit: 'g', of: 1 },
  gr: { unit: 'g', of: 1 },
  gram: { unit: 'g', of: 1 },
  grams: { unit: 'g', of: 1 },
  kg: { unit: 'g', of: 1000 },
  kilogram: { unit: 'g', of: 1000 },
  kilograms: { unit: 'g', of: 1000 },
  mg: { unit: 'g', of: 0.001 },
  oz: { unit: 'g', of: 28.35 },
  ounce: { unit: 'g', of: 28.35 },
  ounces: { unit: 'g', of: 28.35 },
  lb: { unit: 'g', of: 453.6 },
  lbs: { unit: 'g', of: 453.6 },
  pound: { unit: 'g', of: 453.6 },
  pounds: { unit: 'g', of: 453.6 },
  ml: { unit: 'ml', of: 1 },
  millilitre: { unit: 'ml', of: 1 },
  millilitres: { unit: 'ml', of: 1 },
  milliliter: { unit: 'ml', of: 1 },
  milliliters: { unit: 'ml', of: 1 },
  l: { unit: 'ml', of: 1000 },
  litre: { unit: 'ml', of: 1000 },
  litres: { unit: 'ml', of: 1000 },
  liter: { unit: 'ml', of: 1000 },
  liters: { unit: 'ml', of: 1000 },
  tsp: { unit: 'ml', of: 5 },
  teaspoon: { unit: 'ml', of: 5 },
  teaspoons: { unit: 'ml', of: 5 },
  tbsp: { unit: 'ml', of: 15 },
  tablespoon: { unit: 'ml', of: 15 },
  tablespoons: { unit: 'ml', of: 15 },
  cup: { unit: 'ml', of: 240 },
  cups: { unit: 'ml', of: 240 },
  'fl oz': { unit: 'ml', of: 29.57 },
  'fluid ounce': { unit: 'ml', of: 29.57 },
  'fluid ounces': { unit: 'ml', of: 29.57 },
  piece: { unit: 'piece', of: 1 },
  pieces: { unit: 'piece', of: 1 },
  pc: { unit: 'piece', of: 1 },
  pcs: { unit: 'piece', of: 1 },
};

/**
 * Words that stand where a unit stands and are none this file can turn into
 * grams, millilitres or pieces: a clove is no piece of garlic, a can no
 * amount at all. A line with one of them is refused by name, not read as so
 * many pieces of "cloves garlic".
 */
const NO_UNIT_OF_OURS = new Set([
  'clove', 'cloves', 'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'bunch', 'bunches', 'pinch', 'pinches', 'dash', 'dashes', 'handful', 'handfuls',
  'slice', 'slices', 'stick', 'sticks', 'sprig', 'sprigs', 'head', 'heads', 'packet', 'packets', 'package', 'packages', 'pint', 'pints', 'quart', 'quarts', 'gallon', 'gallons',
]);

const FRACTIONS: Record<string, string> = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };

/** `1`, `1.5`, `1,5`, `1/2` or `1 1/2` at the start of a text, and what follows it. */
const AMOUNT = /^(?:(\d+)\s+(\d+)\/(\d+)|(\d+)\/(\d+)|(\d+(?:[.,]\d+)?))\s*/;

export function parseIngredientLine(text: string): ParsedLine {
  let rest = text
    .replace(/[½⅓⅔¼¾⅕⅛⅜⅝⅞]/g, (sign) => ` ${FRACTIONS[sign]}`)
    .replace(/^[\s\-–•*·]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const amount = AMOUNT.exec(rest);
  if (!amount) return { ok: false, problem: 'no-quantity' };
  const [, whole, over, under, top, bottom, plain] = amount;
  const quantity = plain !== undefined ? Number(plain.replace(',', '.')) : whole !== undefined ? Number(whole) + Number(over) / Number(under) : Number(top) / Number(bottom);
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, problem: 'no-quantity' };
  rest = rest.slice(amount[0].length);
  // "2-3 apples", "2 to 3 apples": which of the two is nobody's to pick.
  if (/^(?:[-–]|to\b)\s*\d/.test(rest)) return { ok: false, problem: 'range-for-quantity' };

  // The unit: two words before one, and a word only where it ends ("1 l milk", never the l of "1 lemon").
  const words = rest.toLowerCase().split(' ');
  const two = `${words[0] ?? ''} ${(words[1] ?? '').replace(/\.$/, '')}`;
  const one = (words[0] ?? '').replace(/\.$/, '');
  let measure = { unit: 'piece' as IngredientLine['unit'], of: 1 };
  if (UNITS[two]) {
    measure = UNITS[two];
    rest = rest.split(' ').slice(2).join(' ');
  } else if (UNITS[one]) {
    measure = UNITS[one];
    rest = rest.split(' ').slice(1).join(' ');
  } else if (NO_UNIT_OF_OURS.has(one)) {
    return { ok: false, problem: 'unknown-unit' };
  }

  const name = rest
    .replace(/^of\s+/i, '')
    .replace(/\s*[,(].*$/, '')
    .trim();
  if (name === '') return { ok: false, problem: 'no-name' };
  return { ok: true, line: { quantity: Math.round(quantity * measure.of * 10) / 10, unit: measure.unit, name } };
}
