// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { validateIngredientNamer } from './ingredient-namer.validate.js';

const targetLocales = ['pl'];
const source = {
  'beef-tenderloin':
    'Beef, loin, tenderloin roast, separable lean only, boneless, trimmed to 0" fat, select, cooked, roasted',
  'pears-bartlett': 'Pears, raw, bartlett',
};

function happy(out: Record<string, unknown>): string {
  return JSON.stringify(out);
}

describe('validateIngredientNamer', () => {
  it('accepts a clean response', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: 'Polędwica wołowa' } },
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suggestions['beef-tenderloin'].name.pl).toBe('Polędwica wołowa');
      expect(result.suggestions['pears-bartlett'].storageHint).toBeUndefined();
    }
  });

  it('accepts an optional storageHint', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': {
          name: { pl: 'Polędwica wołowa' },
          storageHint: { pl: 'Trzymaj w lodówce' },
        },
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suggestions['beef-tenderloin'].storageHint?.pl).toBe('Trzymaj w lodówce');
    }
  });

  it('strips a markdown fence before parsing', () => {
    const wrapped = '```json\n' + happy({
      'beef-tenderloin': { name: { pl: 'Polędwica wołowa' } },
      'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
    }) + '\n```';
    const result = validateIngredientNamer({ source, targetLocales, rawOutput: wrapped });
    expect(result.ok).toBe(true);
  });

  it('rejects malformed JSON', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: 'totally not json',
    });
    expect(result).toMatchObject({ ok: false, reason: 'malformed-json' });
  });

  it('keeps the names that are there when one was left out, and says which', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: 'Polędwica wołowa' } },
      }),
    });
    expect(result).toMatchObject({ ok: true, suggestions: { 'beef-tenderloin': { name: { pl: 'Polędwica wołowa' } } }, refused: [{ reason: 'missing-keys', key: 'pears-bartlett' }] });
  });

  it('writes nothing for a slug the source did not ask about, and keeps the others', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: 'Polędwica wołowa' } },
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
        'mystery-slug': { name: { pl: 'Tajemnica' } },
      }),
    });
    expect(result).toMatchObject({ ok: true, refused: [{ reason: 'extra-keys', key: 'mystery-slug' }] });
    expect(result.ok && Object.keys(result.suggestions)).toEqual(['beef-tenderloin', 'pears-bartlett']);
  });

  it('judges a name by itself: one that breaks a rule is refused, and the others of the answer are kept', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: 'Polędwica wołowa 300 kcal' } },
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
      }),
    });
    expect(result).toMatchObject({ ok: true, suggestions: { 'pears-bartlett': { name: { pl: 'Gruszki bartlett' } } }, refused: [{ reason: 'invented-digits', key: 'beef-tenderloin.name.pl' }] });
  });

  it('says the first refusal of an answer nothing can be kept of', () => {
    const result = validateIngredientNamer({ source, targetLocales, rawOutput: happy({ 'beef-tenderloin': { name: { pl: '' } } }) });
    expect(result).toMatchObject({ ok: false, reason: 'empty-value', key: 'beef-tenderloin.name.pl' });
  });

  it('takes a short name of a long description, and refuses a single letter', () => {
    const named = (pl: string) => validateIngredientNamer({ source: { leeks: 'Leeks, bulb and greens, root removed, raw' }, targetLocales, rawOutput: happy({ leeks: { name: { pl } } }) });
    expect(named('Por')).toMatchObject({ ok: true, suggestions: { leeks: { name: { pl: 'Por' } } } });
    expect(named('P')).toMatchObject({ ok: false, reason: 'length-blowup' });
  });

  it('takes a name that is longer than a short description and short all the same, and refuses one padded past that', () => {
    const named = (pl: string) => validateIngredientNamer({ source: { 'oil-corn': 'Oil, corn' }, targetLocales, rawOutput: happy({ 'oil-corn': { name: { pl } } }) });
    expect(named('Olej kukurydziany')).toMatchObject({ ok: true, suggestions: { 'oil-corn': { name: { pl: 'Olej kukurydziany' } } } });
    expect(named('Olej kukurydziany rafinowany')).toMatchObject({ ok: false, reason: 'length-blowup' });
  });

  it('rejects a missing target locale', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales: ['pl', 'de'],
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: 'Polędwica wołowa' } },
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing-locale' });
  });

  it('rejects an empty translation', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: '   ' } },
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
      }),
    });
    expect(result).toMatchObject({ ok: true, refused: [{ reason: 'empty-value', key: 'beef-tenderloin.name.pl' }] });
  });

  it('rejects raw FDC passthrough', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: source['beef-tenderloin'] } },
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
      }),
    });
    expect(result).toMatchObject({ ok: true, refused: [{ reason: 'raw-passthrough', key: 'beef-tenderloin.name.pl' }] });
  });

  it('rejects invented digits', () => {
    const result = validateIngredientNamer({
      source: { 'beef-tenderloin': 'Beef tenderloin' },
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: 'Polędwica wołowa 300 kcal' } },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'invented-digits' });
  });

  it('rejects an answer that explodes well past the source length', () => {
    const result = validateIngredientNamer({
      source: { 'spinach-raw': 'Spinach, raw' },
      targetLocales,
      rawOutput: happy({
        'spinach-raw': {
          name: { pl: 'Szpinak świeży, młody, do sałatek lub gotowania, idealny do koktajli' },
        },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'length-blowup' });
  });

  it('rejects llm-yap prefixes', () => {
    const result = validateIngredientNamer({
      source: { 'pears-bartlett': 'Pears, raw, bartlett' },
      targetLocales,
      rawOutput: happy({
        'pears-bartlett': { name: { pl: 'Note: Gruszki bartlett' } },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'llm-yap' });
  });

  it('drops an empty storageHint object', () => {
    const result = validateIngredientNamer({
      source: { 'pears-bartlett': 'Pears, raw, bartlett' },
      targetLocales,
      rawOutput: happy({
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' }, storageHint: {} },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suggestions['pears-bartlett'].storageHint).toBeUndefined();
    }
  });

  describe('the rules every name is held to', () => {
    const answered = (beef: Record<string, unknown>) =>
      validateIngredientNamer({ source, targetLocales, rawOutput: happy({ 'beef-tenderloin': beef, 'pears-bartlett': { name: { pl: 'Gruszki bartlett' } } }) });

    /** What an answer had refused: the name of beef, beside the pears that are kept. */
    const refusedOf = (result: ReturnType<typeof answered>) => (result.ok ? result.refused : [{ reason: result.reason, key: result.key }]);

    it('refuse markup in a name or a storage hint', () => {
      expect(refusedOf(answered({ name: { pl: '<b>Polędwica wołowa</b>' } }))).toEqual([{ reason: 'markup', key: 'beef-tenderloin.name.pl' }]);
      expect(refusedOf(answered({ name: { pl: 'Polędwica wołowa' }, storageHint: { pl: 'W lodówce, <i>szczelnie</i>' } }))).toEqual([{ reason: 'markup', key: 'beef-tenderloin.storageHint.pl' }]);
    });

    it('refuse a hidden character that reorders what is read', () => {
      expect(refusedOf(answered({ name: { pl: 'Polędwica \u202eawołow' } }))).toMatchObject([{ reason: 'markup' }]);
    });

    it('refuse a storage hint longer than a hint', () => {
      expect(refusedOf(answered({ name: { pl: 'Polędwica wołowa' }, storageHint: { pl: 'x'.repeat(301) } }))).toEqual([{ reason: 'text-too-long', key: 'beef-tenderloin.storageHint.pl' }]);
    });

    it('keep a name as one plain line', () => {
      const result = answered({ name: { pl: ' Polędwica\n wołowa ' } });

      expect(result.ok && result.suggestions['beef-tenderloin']).toEqual({ name: { pl: 'Polędwica wołowa' } });
    });
  });
});
