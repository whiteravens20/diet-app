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
});
