import { describe, expect, it } from 'vitest';
import { MEAL_SLOTS_BY_COUNT, ProfileInput, RegisterRequest } from './index.js';

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
