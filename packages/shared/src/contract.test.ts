// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { DietType, MEAL_SLOTS_BY_COUNT, ProfileInput, RecipeDietTag, RegisterRequest, fitsDiet } from './index.js';

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
