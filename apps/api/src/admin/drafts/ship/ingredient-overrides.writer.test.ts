import { describe, expect, it } from 'vitest';
import { IngredientOverrideEntry } from './ingredient-overrides.writer.js';

describe('IngredientOverrideEntry', () => {
  // Regression: drafts are generated for a locale subset (`targetLocales`,
  // `['pl']` today — EN is the canonical source, not a draft target), so
  // `suggestions.name` is `{ pl: … }` with no `en` key. An exhaustive
  // `z.record(Locale, …)` rejected this, failing every ship with
  // `suggestions-shape-invalid`. The entry must accept a locale subset.
  it('accepts a PL-only suggestion (no en key)', () => {
    const parsed = IngredientOverrideEntry.safeParse({
      name: { pl: 'Polędwica wołowa' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a PL-only suggestion with storageHint', () => {
    const parsed = IngredientOverrideEntry.safeParse({
      name: { pl: 'Szpinak baby' },
      storageHint: { pl: 'Trzymaj w lodówce, zużyj w ciągu 5 dni' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a full en+pl suggestion', () => {
    const parsed = IngredientOverrideEntry.safeParse({
      name: { en: 'Beef tenderloin', pl: 'Polędwica wołowa' },
    });
    expect(parsed.success).toBe(true);
  });

  it('requires the name field', () => {
    expect(IngredientOverrideEntry.safeParse({ storageHint: { pl: 'x' } }).success).toBe(false);
  });

  it('rejects an empty-string value', () => {
    const parsed = IngredientOverrideEntry.safeParse({ name: { pl: '' } });
    expect(parsed.success).toBe(false);
  });
});
