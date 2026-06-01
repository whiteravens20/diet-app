import { createHash } from 'node:crypto';
import type { Unit } from '@diet-app/shared';
import {
  toCanonical,
  UnitConversionError,
  type ConvertibleIngredient,
} from '../../engine/units.js';

/**
 * Stable content hash for a recipe shape — the single source of truth for
 * dedup across curated `Recipe`, personal `Recipe`, and `RecipeDraft`.
 *
 * Hash domain: sorted (slug, canonical-unit, normalized-quantity) tuples +
 * sorted mealTypes + sorted dietTags + servings. Anything that affects
 * nutrition or "what is this recipe structurally" lands in the hash; prose
 * (title / description / steps) does not — that's exactly what the reviewer
 * polishes on identical-fingerprint drafts.
 *
 * Unit equivalence: 100ml of olive oil and 92g of olive oil hash identically
 * once each is converted to the ingredient's canonical unit. Quantities are
 * rounded to 0.1 of a canonical unit so trivial float jitter doesn't break
 * dedup (e.g. a swap that produces 200.0000001g vs 200g).
 */

export interface FingerprintIngredientLine {
  /** Required for the hash — DB id is unstable across instances, slugs are. */
  slug: string;
  quantity: number;
  unit: Unit;
}

export interface FingerprintInput {
  ingredients: readonly FingerprintIngredientLine[];
  mealTypes: readonly string[];
  dietTags: readonly string[];
  servings: number;
}

/**
 * Lookup table the helper needs to canonicalise units. Caller passes one
 * entry per slug referenced by `input.ingredients`. Missing entries throw —
 * we never invent conversions silently.
 */
export type FingerprintIngredientLookup = ReadonlyMap<
  string,
  ConvertibleIngredient
>;

export class FingerprintError extends Error {}

/** SHA256 hex, 64 chars. Stable across instances given identical inputs. */
export function computeFingerprint(
  input: FingerprintInput,
  lookup: FingerprintIngredientLookup,
): string {
  const canonicalLines = input.ingredients
    .map((line) => {
      const ing = lookup.get(line.slug);
      if (!ing) {
        throw new FingerprintError(
          `Fingerprint lookup missing ingredient for slug: ${line.slug}`,
        );
      }
      let canonicalQty: number;
      try {
        canonicalQty = toCanonical(line.quantity, line.unit, ing);
      } catch (err) {
        if (err instanceof UnitConversionError) {
          throw new FingerprintError(
            `Fingerprint cannot canonicalise ${line.slug}: ${err.message}`,
          );
        }
        throw err;
      }
      return {
        slug: line.slug,
        unit: ing.canonicalUnit,
        quantity: roundForFingerprint(canonicalQty),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const canonical = {
    ingredients: canonicalLines,
    mealTypes: [...input.mealTypes].sort(),
    dietTags: [...input.dietTags].sort(),
    servings: input.servings,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Round to 0.1 of a canonical unit so trivial float jitter doesn't break
 * dedup. 200.00000001 and 200.0 hash identically; 200.0 and 200.1 do not
 * (a 0.1g difference in a single ingredient is at the limit of what we'd
 * call "the same recipe").
 */
function roundForFingerprint(quantity: number): number {
  return Math.round(quantity * 10) / 10;
}
