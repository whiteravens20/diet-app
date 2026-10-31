// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { buildIngredientNamerPrompt } from './ingredient-namer.prompt.js';

const source = { banana: 'Bananas, raw', salmon: 'Fish, salmon, Atlantic, raw' };
const targetLocales: ['pl'] = ['pl'];

describe('the prompt that asks for names', () => {
  it('is what it was for ingredients nobody refused a name of', () => {
    const plain = buildIngredientNamerPrompt({ targetLocales, source });

    expect(plain).not.toContain('has refused');
    expect(buildIngredientNamerPrompt({ targetLocales, source, refused: {} })).toBe(plain);
    expect(
      buildIngredientNamerPrompt({
        targetLocales,
        source,
        refused: { kale: [{ name: { pl: 'Zielenina' } }] },
      }),
    ).toBe(plain);
  });

  it('tells the names refused and why, as data, before what is to be rewritten', () => {
    const prompt = buildIngredientNamerPrompt({
      targetLocales,
      source,
      refused: {
        banana: [{ name: { pl: 'Owoc' }, reason: 'Zbyt ogólna' }],
        kale: [{ name: { pl: 'Zielenina' } }],
      },
    });

    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('{"banana":[{"name":{"pl":"Owoc"},"reason":"Zbyt ogólna"}]}');
    expect(prompt).not.toContain('Zielenina');
    expect(prompt.indexOf('has refused')).toBeLessThan(prompt.indexOf('Rewrite this object:'));
  });

  it('cuts a long reason: it goes with every call that asks for that name', () => {
    const prompt = buildIngredientNamerPrompt({
      targetLocales,
      source,
      refused: { banana: [{ name: { pl: 'Owoc' }, reason: 'x'.repeat(500) }] },
    });

    expect(prompt).toContain(`"reason":"${'x'.repeat(200)}"`);
    expect(prompt).not.toContain('x'.repeat(201));
  });
});
