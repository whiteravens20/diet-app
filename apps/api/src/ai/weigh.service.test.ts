// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it, vi } from 'vitest';
import type { AiGenerationMeta } from '@diet-app/shared';
import type { AiRouterService } from './ai-router.service.js';
import { DAY_VARIATIONS } from './operations.js';
import { MAX_WEIGHED_CHARS, WeighService, type Weighing } from './weigh.service.js';

const answered: AiGenerationMeta = {
  provider: 'ollama',
  model: 'test-model',
  failoverChain: [],
  usedDeterministicFallback: false,
  fallbackReason: null,
  reason: null,
};
const noProvider: AiGenerationMeta = {
  provider: null,
  model: null,
  failoverChain: [],
  usedDeterministicFallback: true,
  fallbackReason: 'no_provider',
  reason: null,
};

const asked: Weighing = {
  choice: 'Choose among three ways to fill Tuesday.',
  matters: ['How near the day is to its target.', 'How little of the opened packs is left.'],
  options: [
    { id: 'a', facts: 'Oats | Chicken bowl | Lentil soup | 2010 kcal' },
    { id: 'b', facts: 'Eggs | Tofu bowl | Beef pasta | 1980 kcal' },
    { id: 'c', facts: 'Toast | Salmon | Stew | 2050 kcal' },
  ],
  language: 'English',
};

/** The service with a model that says `text`, or with none when `text` is null. */
function weigher(
  text: string | null,
  meta: AiGenerationMeta = text === null ? noProvider : answered,
) {
  const chat = vi.fn(async () => ({ text, meta }));
  return { service: new WeighService({ chat } as unknown as AiRouterService), chat };
}
const reply = (value: unknown): string => JSON.stringify(value);

describe('a model weighing what the engine proposes', () => {
  it('is shown every option with its id, what matters in order, and is asked for the language of the reader', async () => {
    const { service, chat } = weigher(reply({ order: ['a', 'b', 'c'] }));

    await service.weigh('user-1', DAY_VARIATIONS, { ...asked, language: 'Polish' });

    const [userId, messages, operation, json] = chat.mock.calls[0]! as unknown as [
      string,
      { role: string; content: string }[],
      unknown,
      boolean,
    ];
    expect([userId, operation, json]).toEqual(['user-1', DAY_VARIATIONS, true]);
    expect(messages[0]!.content).toContain('Write the sentences in Polish.');
    expect(messages[1]!.content).toContain('Choose among three ways to fill Tuesday.');
    expect(messages[1]!.content).toContain(
      '1. How near the day is to its target.\n2. How little of the opened packs is left.',
    );
    expect(messages[1]!.content).toContain('- id=b | Eggs | Tofu bowl | Beef pasta | 1980 kcal');
  });

  it('puts the options in the order the model gave, with its sentence on each', async () => {
    const { service } = weigher(
      reply({
        order: ['c', 'a', 'b'],
        reasons: { c: 'Uses up the salmon.', a: 'Closest to the target.', b: 'Heavier on fat.' },
      }),
    );

    const weighed = await service.weigh('user-1', DAY_VARIATIONS, asked);

    expect(weighed.order).toEqual(['c', 'a', 'b']);
    expect([...weighed.said]).toEqual([
      ['a', 'Closest to the target.'],
      ['b', 'Heavier on fat.'],
      ['c', 'Uses up the salmon.'],
    ]);
    expect(weighed.meta).toEqual(answered);
  });

  it('keeps an option the model left out, after the ones it named, and takes an id once', async () => {
    const { service } = weigher(reply({ order: ['b', 'b', 'c'], reasons: { b: 'Fine.' } }));

    expect((await service.weigh('user-1', DAY_VARIATIONS, asked)).order).toEqual(['b', 'c', 'a']);
  });

  it('ignores an id that was not on offer, and a sentence on one', async () => {
    const { service } = weigher(
      reply({
        order: ['z', 'c', 7, 'constructor'],
        reasons: { z: 'An option of my own.', constructor: 'No.', c: 'Good.' },
      }),
    );

    const weighed = await service.weigh('user-1', DAY_VARIATIONS, asked);

    expect(weighed.order).toEqual(['c', 'a', 'b']);
    expect([...weighed.said]).toEqual([['c', 'Good.']]);
  });

  it('passes a sentence on as one plain line, cut where it is too long, and none where the model gave none', async () => {
    const long = 'word '.repeat(80);
    const { service } = weigher(
      reply({ order: ['a', 'b', 'c'], reasons: { a: 'Two\nlines\tof it.', b: long, c: 42 } }),
    );

    const { said } = await service.weigh('user-1', DAY_VARIATIONS, asked);

    expect(said.get('a')).toBe('Two lines of it.');
    expect(said.get('b')!.length).toBeLessThanOrEqual(MAX_WEIGHED_CHARS);
    expect(said.get('b')!.endsWith('…')).toBe(true);
    expect(said.has('c')).toBe(false);
  });

  it('takes an order without sentences: a sentence is welcome and never required', async () => {
    const { service } = weigher(reply({ order: ['b', 'a', 'c'] }));

    const weighed = await service.weigh('user-1', DAY_VARIATIONS, asked);

    expect(weighed.order).toEqual(['b', 'a', 'c']);
    expect(weighed.said.size).toBe(0);
    expect(weighed.meta.usedDeterministicFallback).toBe(false);
  });

  it.each([
    ['is not JSON', 'I would take the second one.'],
    ['has another shape', reply({ best: 'b' })],
    ['names none of the options', reply({ order: ['x', 'y'], reasons: { x: 'Mine.' } })],
    ['gives no list', reply({ order: 'b' })],
  ])(
    'leaves the order as the engine had it when the answer %s, and says that the engine decided',
    async (_what, text) => {
      const { service } = weigher(text);

      const weighed = await service.weigh('user-1', DAY_VARIATIONS, asked);

      expect(weighed.order).toEqual(['a', 'b', 'c']);
      expect(weighed.said.size).toBe(0);
      expect(weighed.meta).toEqual({
        ...answered,
        usedDeterministicFallback: true,
        fallbackReason: 'invalid_output',
      });
    },
  );

  it('leaves the order as the engine had it when no model answers, with the reason the router gave', async () => {
    const { service } = weigher(null);

    const weighed = await service.weigh('user-1', DAY_VARIATIONS, asked);

    expect(weighed.order).toEqual(['a', 'b', 'c']);
    expect(weighed.meta).toEqual(noProvider);
  });
});
