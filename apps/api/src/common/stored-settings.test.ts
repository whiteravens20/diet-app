// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { storedAiMode, storedLocale, storedPalette, storedTheme, storedWeightUnit } from './stored-settings.js';

describe('what an account chose, as its row holds it', () => {
  it('is read as it is when the application knows the value', () => {
    expect([storedLocale('pl'), storedTheme('dark'), storedPalette('ocean'), storedAiMode('byok'), storedWeightUnit('lb')]).toEqual(['pl', 'dark', 'ocean', 'byok', 'lb']);
  });

  it('is read as the choice an account begins with when the value is one this version does not know', () => {
    expect([storedLocale('de'), storedTheme('sepia'), storedPalette('neon'), storedAiMode('shared'), storedWeightUnit('stone')]).toEqual(['en', 'system', 'default', 'none', null]);
    expect([storedLocale(null), storedTheme(undefined), storedPalette(''), storedAiMode(''), storedWeightUnit(null)]).toEqual(['en', 'system', 'default', 'none', null]);
  });
});
