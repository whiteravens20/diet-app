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

  it('rejects a missing slug key', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: 'Polędwica wołowa' } },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing-keys', key: 'pears-bartlett' });
  });

  it('rejects an extra slug key the source did not ask for', () => {
    const result = validateIngredientNamer({
      source,
      targetLocales,
      rawOutput: happy({
        'beef-tenderloin': { name: { pl: 'Polędwica wołowa' } },
        'pears-bartlett': { name: { pl: 'Gruszki bartlett' } },
        'mystery-slug': { name: { pl: 'Tajemnica' } },
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'extra-keys', key: 'mystery-slug' });
  });

  it('takes a short name of a long description, and refuses a single letter', () => {
    const named = (pl: string) => validateIngredientNamer({ source: { leeks: 'Leeks, bulb and greens, root removed, raw' }, targetLocales, rawOutput: happy({ leeks: { name: { pl } } }) });
    expect(named('Por')).toMatchObject({ ok: true, suggestions: { leeks: { name: { pl: 'Por' } } } });
    expect(named('P')).toMatchObject({ ok: false, reason: 'length-blowup' });
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
    expect(result).toMatchObject({ ok: false, reason: 'empty-value' });
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
    expect(result).toMatchObject({ ok: false, reason: 'raw-passthrough' });
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

    it('refuse markup in a name or a storage hint', () => {
      expect(answered({ name: { pl: '<b>Polędwica wołowa</b>' } })).toEqual({ ok: false, reason: 'markup', key: 'beef-tenderloin.name.pl' });
      expect(answered({ name: { pl: 'Polędwica wołowa' }, storageHint: { pl: 'W lodówce, <i>szczelnie</i>' } })).toEqual({
        ok: false,
        reason: 'markup',
        key: 'beef-tenderloin.storageHint.pl',
      });
    });

    it('refuse a hidden character that reorders what is read', () => {
      expect(answered({ name: { pl: 'Polędwica \u202eawołow' } })).toMatchObject({ ok: false, reason: 'markup' });
    });

    it('refuse a storage hint longer than a hint', () => {
      expect(answered({ name: { pl: 'Polędwica wołowa' }, storageHint: { pl: 'x'.repeat(301) } })).toEqual({ ok: false, reason: 'text-too-long', key: 'beef-tenderloin.storageHint.pl' });
    });

    it('keep a name as one plain line', () => {
      const result = answered({ name: { pl: ' Polędwica\n wołowa ' } });

      expect(result.ok && result.suggestions['beef-tenderloin']).toEqual({ name: { pl: 'Polędwica wołowa' } });
    });
  });
});
