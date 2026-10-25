// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  CaloriePreviewRequest,
  riskOfLosingWeight,
  type Profile,
  type WeightUnit,
} from '@diet-app/shared';
import { toKilograms } from './weight-unit';

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
    weeklyLossTarget: kept.weeklyLossTarget,
    manualCalorieTarget: kept.manualCalorieTarget,
    acknowledgeRisk: kept.riskAcknowledgedAt !== null,
  };
}

/** A number a field of the form holds; nothing for a field that is empty or is not there. */
function typed(fields: FormData, name: string): number | undefined {
  const written = String(fields.get(name) ?? '').trim();
  return written === '' ? undefined : Number(written);
}

/** The same risk, for what a profile form holds at this moment; its weight is typed in the unit of the account. */
export function riskIn(form: HTMLFormElement, unit: WeightUnit): Risk[] {
  const fields = new FormData(form);
  return riskOf({
    age: typed(fields, 'age') ?? 0,
    heightCm: typed(fields, 'heightCm') ?? 0,
    weightKg: toKilograms(typed(fields, 'weight') ?? 0, unit),
    weeklyLossTarget: String(fields.get('weeklyLossTarget') ?? '') || null,
    manualCalorieTarget: typed(fields, 'manualCalorieTarget') ?? null,
  });
}

/**
 * What a profile form holds at this moment, as the figures a calorie target
 * is worked out from; null while they are not ones the API would take: a
 * field still empty, a number out of its bounds, a split that does not add
 * up. A form asks for the target only with figures it could also save.
 */
export function figuresIn(form: HTMLFormElement, unit: WeightUnit): CaloriePreviewRequest | null {
  const fields = new FormData(form);
  const weight = typed(fields, 'weight');
  const asked = CaloriePreviewRequest.safeParse({
    age: typed(fields, 'age'),
    sex: fields.get('sex') || null,
    heightCm: typed(fields, 'heightCm'),
    weightKg: weight === undefined ? undefined : toKilograms(weight, unit),
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
    weeklyLossTarget: fields.get('weeklyLossTarget') || null,
    manualCalorieTarget: typed(fields, 'manualCalorieTarget') ?? null,
    acknowledgeRisk: fields.get('acknowledgeRisk') === 'on',
  });
  return asked.success ? asked.data : null;
}
