// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { figuresIn, riskIn } from './typed-figures';

/** A form that holds `fields`, each under its name. */
function aForm(fields: Record<string, string>): HTMLFormElement {
  const form = document.createElement('form');
  for (const [name, value] of Object.entries(fields)) {
    const field = document.createElement('input');
    field.name = name;
    field.value = value;
    form.append(field);
  }
  return form;
}

const TYPED = { age: '30', sex: 'male', heightCm: '180', weight: '80', activityLevel: 'active', dietType: 'vegan', weeklyLossTarget: '0.25', manualCalorieTarget: '' };

describe('the figures a profile form holds, as a calorie target is worked out from them', () => {
  it('are what was typed, with nothing for a field left empty', () => {
    expect(figuresIn(aForm(TYPED), 'kg')).toEqual({
      age: 30,
      sex: 'male',
      heightCm: 180,
      weightKg: 80,
      activityLevel: 'active',
      dietType: 'vegan',
      customMacroSplit: null,
      weeklyLossTarget: '0.25',
      manualCalorieTarget: null,
      acknowledgeRisk: false,
    });
  });

  it('hold the weight in kilograms, whatever unit it was typed in', () => {
    expect(figuresIn(aForm({ ...TYPED, weight: '176.4' }), 'lb')?.weightKg).toBe(80.01);
  });

  it('take no pace for keeping the weight, no sex for not saying, and a target of one\'s own as a number', () => {
    expect(figuresIn(aForm({ ...TYPED, sex: '', weeklyLossTarget: '', manualCalorieTarget: '1900' }), 'kg')).toMatchObject({ sex: null, weeklyLossTarget: null, manualCalorieTarget: 1900 });
  });

  it('are given what a new profile is given by a form that does not ask for the activity, the diet or the pace', () => {
    expect(figuresIn(aForm({ age: '30', heightCm: '180', weight: '80' }), 'kg')).toMatchObject({ activityLevel: 'moderate', dietType: 'balanced', weeklyLossTarget: null });
  });

  it.each([
    ['a field is still empty', { ...TYPED, heightCm: '' }],
    ['an age is under the least a profile may have', { ...TYPED, age: '12' }],
    ['a weight is over the most', { ...TYPED, weight: '500' }],
    ['a target of one\'s own is under the least', { ...TYPED, manualCalorieTarget: '300' }],
    ['the split of the custom diet does not add up', { ...TYPED, dietType: 'custom', splitProtein: '30', splitFat: '40', splitCarbs: '40' }],
    ['the split of the custom diet is not typed', { ...TYPED, dietType: 'custom' }],
  ])('are none while %s', (_why, fields) => {
    expect(figuresIn(aForm(fields), 'kg')).toBeNull();
  });

  it('hold the split of the custom diet, and none on another diet', () => {
    const split = { splitProtein: '30', splitFat: '40', splitCarbs: '30' };

    expect(figuresIn(aForm({ ...TYPED, dietType: 'custom', ...split }), 'kg')?.customMacroSplit).toEqual({ protein: 30, fat: 40, carbs: 30 });
    expect(figuresIn(aForm({ ...TYPED, ...split }), 'kg')?.customMacroSplit).toBeNull();
  });

  it('say whether the risk of losing weight was acknowledged', () => {
    expect(figuresIn(aForm({ ...TYPED, acknowledgeRisk: 'on' }), 'kg')?.acknowledgeRisk).toBe(true);
  });
});

describe('the risk a form\'s loss goal carries for the body it describes', () => {
  it('is that of somebody under 18, and of somebody underweight', () => {
    expect(riskIn(aForm({ ...TYPED, age: '16' }), 'kg')).toEqual(['minor']);
    expect(riskIn(aForm({ ...TYPED, weight: '55' }), 'kg')).toEqual(['underweight']);
    expect(riskIn(aForm({ ...TYPED, age: '16', weight: '121' }), 'lb')).toEqual(['minor', 'underweight']);
  });

  it('is none for a body that keeps its weight, and none while the body is not typed', () => {
    expect(riskIn(aForm({ ...TYPED, age: '16', weeklyLossTarget: '' }), 'kg')).toEqual([]);
    expect(riskIn(aForm({ ...TYPED, age: '16', weeklyLossTarget: '', manualCalorieTarget: '1800' }), 'kg')).toEqual(['minor']);
    expect(riskIn(aForm({ ...TYPED, age: '16', heightCm: '' }), 'kg')).toEqual([]);
  });
});
