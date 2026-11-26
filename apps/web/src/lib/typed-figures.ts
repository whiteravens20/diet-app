// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  CaloriePreviewRequest,
  riskOfLosingWeight,
  type Profile,
  type WeightUnit,
} from '@diet-app/shared';
import { weightIn } from './weight-unit';

export type Risk = ReturnType<typeof riskOfLosingWeight>[number];

/** The risk a loss goal carries for a body, or none when no loss is asked for. */
export function riskOf(body: {
  age: number;
  heightCm: number;
  weightKg: number;
  weeklyLossTarget: string | null;
  manualCalorieTarget: number | null;
}): Risk[] {
  const asksForLoss = body.weeklyLossTarget !== null || body.manualCalorieTarget !== null;
  if (!asksForLoss || !(body.age > 0 && body.heightCm > 0 && body.weightKg > 0)) return [];
  return riskOfLosingWeight(body);
}

/** The figures a profile's calorie target is worked out from, as the profile keeps them: what its form shows before anything is typed. */
export function figuresOf(kept: Profile): CaloriePreviewRequest {
  return {
    age: kept.age,
    sex: kept.sex,
    heightCm: kept.heightCm,
    weightKg: kept.weightKg,
    activityLevel: kept.activityLevel,
    dietType: kept.dietType,
    customMacroSplit: kept.customMacroSplit,
    customProteinPerKg: kept.customProteinPerKg,
    weeklyLossTarget: kept.weeklyLossTarget,
    manualCalorieTarget: kept.manualCalorieTarget,
    expenditureCorrection: kept.expenditureCorrectionKcal ?? 0,
  };
}

/** A number a field of the form holds; nothing for a field that is empty or is not there. */
function typed(fields: FormData, name: string): number | undefined {
  const written = String(fields.get(name) ?? '').trim();
  return written === '' ? undefined : Number(written);
}

/**
 * The same risk, for what a profile form holds at this moment; its weight is
 * typed in the unit of the account, and is `keptWeightKg` while it still shows
 * that, as the profile keeps it.
 */
export function riskIn(
  form: HTMLFormElement,
  unit: WeightUnit,
  keptWeightKg: number | null = null,
): Risk[] {
  const fields = new FormData(form);
  return riskOf({
    age: typed(fields, 'age') ?? 0,
    heightCm: typed(fields, 'heightCm') ?? 0,
    weightKg: weightIn(fields.get('weight'), keptWeightKg, unit) ?? 0,
    weeklyLossTarget: String(fields.get('weeklyLossTarget') ?? '') || null,
    manualCalorieTarget: typed(fields, 'manualCalorieTarget') ?? null,
  });
}

/**
 * What a profile form holds at this moment, as the figures a calorie target
 * is worked out from; null while they are not ones the API would take: a
 * field still empty, a number out of its bounds, a split that does not add
 * up. A form asks for the target only with figures it could also save, its
 * weight `keptWeightKg` while the field still shows that, as it is saved.
 */
export function figuresIn(
  form: HTMLFormElement,
  unit: WeightUnit,
  keptWeightKg: number | null = null,
): CaloriePreviewRequest | null {
  const fields = new FormData(form);
  const asked = CaloriePreviewRequest.safeParse({
    age: typed(fields, 'age'),
    sex: fields.get('sex') || null,
    heightCm: typed(fields, 'heightCm'),
    weightKg: weightIn(fields.get('weight'), keptWeightKg, unit) ?? undefined,
    activityLevel: fields.get('activityLevel') ?? undefined,
    dietType: fields.get('dietType') ?? undefined,
    customMacroSplit:
      fields.get('dietType') === 'custom'
        ? {
            protein: typed(fields, 'splitProtein'),
            fat: typed(fields, 'splitFat'),
            carbs: typed(fields, 'splitCarbs'),
          }
        : null,
    // The custom diet's protein per kilogram, where the form sets protein so.
    customProteinPerKg:
      fields.get('dietType') === 'custom' && fields.get('customWay') === 'perKg'
        ? (typed(fields, 'customProteinPerKg') ?? null)
        : null,
    weeklyLossTarget: fields.get('weeklyLossTarget') || null,
    manualCalorieTarget: typed(fields, 'manualCalorieTarget') ?? null,
  });
  return asked.success ? asked.data : null;
}
