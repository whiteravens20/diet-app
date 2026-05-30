/**
 * Recipe-draft complexity bands.
 *
 * Single source of truth for what counts as `simple | medium | complex`. Used
 * by:
 *   - The prompt renderer (instructs the model on band thresholds + the
 *     requested distribution).
 *   - The few-shot loader (stratifies exemplars so each band shows up in the
 *     prompt context).
 *   - The validator (auto-tags every draft + emits a batch-level
 *     drift warning when the realised mix deviates from the spec).
 *   - The queue filter UI (band chips on each draft row).
 *
 * Bands are inclusive on both ends. A recipe outside every band (≤ 2
 * ingredients or 16+, ≥ 21 steps, > 90 min total) is rejected by the
 * validator — we're not willing to ship those without manual override.
 */
import type { Complexity, ComplexityMix } from '@diet-app/shared';

export interface ComplexityBand {
  name: Complexity;
  minIngredients: number;
  maxIngredients: number;
  maxSteps: number;
  /** prep + cook, minutes. */
  maxTotalMinutes: number;
}

// Caps relaxed after live testing — the original 6 steps / 20 min was too
// strict for normal home cooking (a 5-ingredient stir-fry routinely needs 7
// steps and 25 min). Bands are picked primarily by ingredient count; step
// and time are upper bounds inside the band.
export const COMPLEXITY_BANDS: readonly ComplexityBand[] = [
  { name: 'simple', minIngredients: 3, maxIngredients: 5, maxSteps: 8, maxTotalMinutes: 30 },
  { name: 'medium', minIngredients: 6, maxIngredients: 9, maxSteps: 14, maxTotalMinutes: 60 },
  { name: 'complex', minIngredients: 10, maxIngredients: 16, maxSteps: 25, maxTotalMinutes: 120 },
] as const;

/** Default mix when the spec omits `complexityMix`. Matches plan D1. */
export const DEFAULT_COMPLEXITY_MIX: ComplexityMix = {
  simple: 0.3,
  medium: 0.5,
  complex: 0.2,
};

/**
 * Pick the complexity band a recipe falls into. Returns `null` when the
 * recipe is outside every band — the validator treats that as a rejection.
 */
export function classifyComplexity(input: {
  ingredientCount: number;
  stepCount: number;
  totalMinutes: number;
}): Complexity | null {
  for (const band of COMPLEXITY_BANDS) {
    if (
      input.ingredientCount >= band.minIngredients &&
      input.ingredientCount <= band.maxIngredients &&
      input.stepCount <= band.maxSteps &&
      input.totalMinutes <= band.maxTotalMinutes
    ) {
      return band.name;
    }
  }
  return null;
}

/** Normalise a `ComplexityMix` so it sums to 1.0. Zero-sum mix falls back
 *  to the default — protects the runner from accidentally generating
 *  zero recipes. */
export function normaliseMix(mix: ComplexityMix): ComplexityMix {
  const sum = mix.simple + mix.medium + mix.complex;
  if (sum <= 0) return DEFAULT_COMPLEXITY_MIX;
  return {
    simple: mix.simple / sum,
    medium: mix.medium / sum,
    complex: mix.complex / sum,
  };
}

/** Translate a `count` + mix into target counts per band. Uses largest-
 *  remainder so the total always sums to `count`. */
export function targetsForMix(count: number, mix: ComplexityMix): Record<Complexity, number> {
  const normalised = normaliseMix(mix);
  const raw: Record<Complexity, number> = {
    simple: count * normalised.simple,
    medium: count * normalised.medium,
    complex: count * normalised.complex,
  };
  const floored: Record<Complexity, number> = {
    simple: Math.floor(raw.simple),
    medium: Math.floor(raw.medium),
    complex: Math.floor(raw.complex),
  };
  let remaining = count - (floored.simple + floored.medium + floored.complex);
  const remainders = (Object.keys(raw) as Complexity[])
    .map((k) => ({ k, frac: raw[k] - floored[k] }))
    .sort((a, b) => b.frac - a.frac);
  for (const { k } of remainders) {
    if (remaining <= 0) break;
    floored[k] += 1;
    remaining -= 1;
  }
  return floored;
}

/** Whether the realised mix (counts per band) deviates from the target mix
 *  by > `tolerancePp` percentage-points in any band. The runner surfaces this
 *  as a yellow warning chip on the batch; it never rejects. */
export function batchMixDrift(opts: {
  realised: Record<Complexity, number>;
  target: ComplexityMix;
  total: number;
  tolerancePp?: number;
}): { drifted: boolean; deltas: Record<Complexity, number> } {
  const tolerance = opts.tolerancePp ?? 25;
  const target = normaliseMix(opts.target);
  const realisedFraction: Record<Complexity, number> = {
    simple: opts.total === 0 ? 0 : opts.realised.simple / opts.total,
    medium: opts.total === 0 ? 0 : opts.realised.medium / opts.total,
    complex: opts.total === 0 ? 0 : opts.realised.complex / opts.total,
  };
  const deltas: Record<Complexity, number> = {
    simple: Math.round((realisedFraction.simple - target.simple) * 100),
    medium: Math.round((realisedFraction.medium - target.medium) * 100),
    complex: Math.round((realisedFraction.complex - target.complex) * 100),
  };
  const drifted = (Object.values(deltas) as number[]).some(
    (d) => Math.abs(d) > tolerance,
  );
  return { drifted, deltas };
}
