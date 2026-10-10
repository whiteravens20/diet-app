// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_MODEL_REPLY_CHARS, modelText, readModelObject, readModelReply } from './model-json.js';

describe('readModelObject', () => {
  it.each([
    ['a bare object', '{"recipeId":"a"}'],
    ['an object in a json fence', '```json\n{"recipeId":"a"}\n```'],
    ['an object in a plain fence without a final newline', '```\n{"recipeId":"a"}```'],
    ['an object with prose around it', 'Sure, here you go: {"recipeId":"a"} Hope that helps!'],
    ['a fence glued to the object', '```json{"recipeId":"a"}```'],
    ['surrounding whitespace', '  \n {"recipeId":"a"} \n '],
  ])('reads %s', (_name, reply) => {
    expect(readModelObject(reply)).toEqual({ ok: true, value: { recipeId: 'a' } });
  });

  it.each([
    ['no object at all', 'I cannot help with that.'],
    ['an array', '["a","b"]'],
    ['a truncated object', '{"recipeId":"a"'],
    ['an empty reply', ''],
    ['a closing brace before an opening one', '} {'],
    ['two objects side by side', '{"recipeId":"a"} {"recipeId":"b"}'],
  ])('finds no object in %s', (_name, reply) => {
    expect(readModelObject(reply)).toEqual({ ok: false, problem: 'no_json_object' });
  });

  it('refuses a reply longer than the limit, however valid', () => {
    const reply = `{"recipeId":"a","padding":"${'x'.repeat(MAX_MODEL_REPLY_CHARS)}"}`;
    expect(readModelObject(reply)).toEqual({ ok: false, problem: 'too_long' });
    expect(readModelObject(reply, reply.length)).toMatchObject({ ok: true, value: { recipeId: 'a' } });
  });
});

describe('readModelReply', () => {
  const Pick = z.object({ recipeId: z.string().min(1) });

  it('returns the value the schema describes', () => {
    expect(readModelReply('{"recipeId":"a","confidence":0.9}', Pick)).toEqual({
      ok: true,
      value: { recipeId: 'a' },
    });
  });

  it.each([
    ['a missing key', '{"recipe":"a"}'],
    ['a key of the wrong type', '{"recipeId":7}'],
    ['an empty value', '{"recipeId":""}'],
  ])('reports the wrong shape for %s', (_name, reply) => {
    expect(readModelReply(reply, Pick)).toEqual({ ok: false, problem: 'wrong_shape' });
  });

  it('reports an unreadable reply before it looks at the shape', () => {
    expect(readModelReply('no', Pick)).toEqual({ ok: false, problem: 'no_json_object' });
    expect(readModelReply('x'.repeat(MAX_MODEL_REPLY_CHARS + 1), Pick)).toEqual({ ok: false, problem: 'too_long' });
  });
});

describe('modelText', () => {
  it('keeps an ordinary sentence as it is', () => {
    expect(modelText('Closest to your calorie budget.', 200)).toBe('Closest to your calorie budget.');
  });

  it('folds line breaks, tabs and control characters into single spaces', () => {
    expect(modelText('  one\n\ntwo\tthree\u0000\u0007four\u0085five  ', 200)).toBe('one two three four five');
  });

  it('cuts a long text to the limit and marks the cut', () => {
    const cut = modelText('word '.repeat(100), 50)!;
    expect(cut).toHaveLength(50);
    expect(cut.endsWith('…')).toBe(true);
    // A cut that lands on a space does not leave it before the mark.
    expect(modelText('word '.repeat(100), 6)).toBe('word…');
  });

  it.each([[undefined], [null], [42], [{ text: 'nested' }], [['list']], [''], ['  \n\t ']])('has nothing to show for %j', (value) => {
    expect(modelText(value, 200)).toBeNull();
  });

  it('leaves markup as the text it is, for the client to show literally', () => {
    expect(modelText('<b>bold</b> & <script>alert(1)</script>', 200)).toBe('<b>bold</b> & <script>alert(1)</script>');
  });
});

describe('a hostile reply', () => {
  // Each of the first three stalled the process for seconds when replies were
  // read with backtracking patterns. The budget is generous: the point is that
  // the time no longer grows with the square of the length.
  it.each([
    ['a long run of spaces after the object', (n: number) => `\`\`\`json\n{"recipeId":"x"}${' '.repeat(n)}x`],
    ['a long run of opening braces', (n: number) => '{'.repeat(n)],
    ['a long run of newlines inside a fence', (n: number) => `\`\`\`json\n${'\n'.repeat(n)}`],
    ['five megabytes of text', () => 'A'.repeat(5_000_000)],
  ])('is read in linear time: %s', (_name, make) => {
    const reply = make(1_000_000);
    for (const limit of [MAX_MODEL_REPLY_CHARS, 10_000_000]) {
      const started = performance.now();
      readModelObject(reply, limit);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});
