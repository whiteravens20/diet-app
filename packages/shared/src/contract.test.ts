// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { CaloriePreviewRequest, DietType, FdcDataTypes, MacroSplit, MEAL_SLOTS_BY_COUNT, PACES_OF_LOSS, ProfileInput, ProfileUpdate, RecipeDietTag, RegisterRequest, fitsDiet } from './index.js';

describe('fitsDiet', () => {
  it.each(RecipeDietTag.options)('admits a recipe to a %s plan only when it carries that tag', (diet) => {
    expect(fitsDiet([diet], diet)).toBe(true);
    expect(fitsDiet([], diet)).toBe(false);
    expect(fitsDiet(RecipeDietTag.options.filter((tag) => tag !== diet), diet)).toBe(false);
  });

  it.each(['balanced', 'high_protein', 'custom'] as const)('admits any recipe to a %s plan', (diet) => {
    expect(fitsDiet([], diet)).toBe(true);
    expect(fitsDiet(['keto'], diet)).toBe(true);
  });

  it('knows every diet as one that needs a tag or one that does not', () => {
    const needsTag = DietType.options.filter((diet) => !fitsDiet([], diet));
    expect([...needsTag].sort()).toEqual([...RecipeDietTag.options].sort());
  });
});

describe('the data sets of the food database an import may name', () => {
  it.each([
    ['Foundation', 'Foundation'],
    ['Foundation,SR Legacy', 'Foundation,SR Legacy'],
    [' SR Legacy , Foundation ', 'SR Legacy,Foundation'],
    [['Foundation', 'SR Legacy'], 'Foundation,SR Legacy'],
  ])('takes %j', (given, parsed) => {
    expect(FdcDataTypes.parse(given)).toBe(parsed);
  });

  it.each(['', ' , ', 'Branded', 'Foundation,Branded', 'Foundation,Foundation', 'foundation', ['Foundation', 'Survey (FNDDS)'], 42])(
    'refuses %j',
    (given) => {
      expect(FdcDataTypes.safeParse(given).success).toBe(false);
    },
  );
});

describe('API contract schemas', () => {
  it('accepts a valid registration payload', () => {
    const result = RegisterRequest.safeParse({
      email: 'a@example.com',
      password: 'Str0ngPassphrase',
      displayName: 'Alex',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a too-short password', () => {
    const result = RegisterRequest.safeParse({
      email: 'a@example.com',
      password: 'Short1',
      displayName: 'Alex',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password without an uppercase letter or digit', () => {
    const result = RegisterRequest.safeParse({
      email: 'a@example.com',
      password: 'all-lowercase-no-digits',
      displayName: 'Alex',
    });
    expect(result.success).toBe(false);
  });

  it('applies ProfileInput defaults', () => {
    const parsed = ProfileInput.parse({
      name: 'Default',
      age: 30,
      heightCm: 175,
      weightKg: 75,
    });
    expect(parsed.mealCount).toBe(3);
    expect(parsed.dietType).toBe('balanced');
  });

  it('maps every meal count 2-5 to a slot list', () => {
    for (const count of [2, 3, 4, 5]) {
      expect(MEAL_SLOTS_BY_COUNT[count]).toHaveLength(count);
    }
  });
});

describe('the figures a calorie target is worked out from before there is a profile', () => {
  const typed = { age: 30, heightCm: 180, weightKg: 80 };

  it('are given what a new profile is given for what they leave out', () => {
    const asked = CaloriePreviewRequest.parse(typed);
    const made = ProfileInput.parse({ ...typed, name: 'Me' });

    expect(asked).toEqual({
      ...typed,
      sex: made.sex,
      activityLevel: made.activityLevel,
      dietType: made.dietType,
      customMacroSplit: made.customMacroSplit,
      weeklyLossTarget: made.weeklyLossTarget,
      manualCalorieTarget: made.manualCalorieTarget,
      acknowledgeRisk: false,
    });
  });

  it('are held to the bounds of a profile', () => {
    expect(CaloriePreviewRequest.safeParse({ ...typed, age: 12 }).success).toBe(false);
    expect(CaloriePreviewRequest.safeParse({ ...typed, weightKg: 29 }).success).toBe(false);
    expect(CaloriePreviewRequest.safeParse({ ...typed, manualCalorieTarget: 1 }).success).toBe(false);
    expect(CaloriePreviewRequest.safeParse({ ...typed, dietType: 'custom' }).error?.issues[0]?.path).toEqual(['customMacroSplit']);
  });

  it('are worked out at every pace a profile may choose, beginning with no loss', () => {
    expect(PACES_OF_LOSS).toEqual([null, '0.25', '0.5', '0.75', '1.0']);
  });
});

describe("somebody's own split of a day's energy", () => {
  it('is whole per cent that add up to a hundred', () => {
    expect(MacroSplit.safeParse({ protein: 30, fat: 40, carbs: 30 }).success).toBe(true);
    expect(MacroSplit.safeParse({ protein: 30, fat: 40, carbs: 31 }).success).toBe(false);
    expect(MacroSplit.safeParse({ protein: 30.5, fat: 39.5, carbs: 30 }).success).toBe(false);
    expect(MacroSplit.safeParse({ protein: 30, fat: 40 }).success).toBe(false);
  });

  it('gives each of the three at least what a diet needs of it and at most what leaves room for the others', () => {
    // The splits of the diets the application names all fit.
    for (const split of [{ protein: 25, fat: 70, carbs: 5 }, { protein: 40, fat: 30, carbs: 30 }, { protein: 20, fat: 28, carbs: 52 }]) {
      expect(MacroSplit.safeParse(split).success).toBe(true);
    }
    for (const split of [{ protein: 9, fat: 41, carbs: 50 }, { protein: 46, fat: 24, carbs: 30 }, { protein: 30, fat: 14, carbs: 56 }, { protein: 20, fat: 76, carbs: 4 }, { protein: 15, fat: 15, carbs: 70 + 1 }]) {
      expect(MacroSplit.safeParse(split).success).toBe(false);
    }
  });

  const aProfile = { name: 'Me', age: 30, heightCm: 180, weightKg: 80 };

  it('is what a profile on the custom diet has to say', () => {
    const without = ProfileInput.safeParse({ ...aProfile, dietType: 'custom' });
    expect(without.success).toBe(false);
    expect(without.error?.issues[0]?.path).toEqual(['customMacroSplit']);

    expect(ProfileInput.parse({ ...aProfile, dietType: 'custom', customMacroSplit: { protein: 30, fat: 40, carbs: 30 } }).customMacroSplit).toEqual({ protein: 30, fat: 40, carbs: 30 });
  });

  it('is nothing a profile on another diet has to say, and something it may keep', () => {
    expect(ProfileInput.parse(aProfile).customMacroSplit).toBeNull();
    expect(ProfileInput.parse({ ...aProfile, dietType: 'vegan', customMacroSplit: { protein: 30, fat: 40, carbs: 30 } }).customMacroSplit).toEqual({ protein: 30, fat: 40, carbs: 30 });
  });

  it('is a part of a profile that a change of the whole profile names like every other', () => {
    const whole = { ...ProfileInput.parse(aProfile) };
    expect(ProfileUpdate.safeParse(whole).success).toBe(true);
    const withoutIt = Object.fromEntries(Object.entries(whole).filter(([part]) => part !== 'customMacroSplit'));
    expect(ProfileUpdate.safeParse(withoutIt).success).toBe(false);
    expect(ProfileUpdate.safeParse({ ...whole, dietType: 'custom' }).success).toBe(false);
  });
});
