/**
 * Validator corpus — locks down the failure modes the runner must reject and
 * the shapes it must accept. Add a row to either array when a new LLM trick
 * shows up in production logs.
 */
import { describe, expect, it } from 'vitest';
import { extractJson, validate, type ValidationReason } from './validate.js';

const SOURCE_PL = {
  name: 'Chicken breast',
  storageHint: 'Refrigerate, use within 2 days',
};

interface Bad {
  why: string;
  raw: string;
  reason: ValidationReason;
}

const REJECTED: Bad[] = [
  {
    why: 'plain prose, not JSON',
    raw: 'Sure, here is the translation: Pierś z kurczaka.',
    reason: 'malformed-json',
  },
  {
    why: 'JSON missing a requested key',
    raw: '{"name":"Pierś z kurczaka"}',
    reason: 'missing-keys',
  },
  {
    why: 'extra unrequested keys',
    raw: '{"name":"Pierś z kurczaka","storageHint":"Lodówka","extra":"x"}',
    reason: 'extra-keys',
  },
  {
    why: 'LLM yapping with Note: prefix',
    raw: '{"name":"Note: in Polish we say Pierś z kurczaka","storageHint":"Lodówka"}',
    reason: 'llm-yap',
  },
  {
    why: 'refusal language',
    raw: '{"name":"I cannot translate this","storageHint":"Lodówka"}',
    reason: 'llm-yap',
  },
  {
    why: 'wrapped in added quotes',
    raw: '{"name":"\\"Pierś z kurczaka\\"","storageHint":"Lodówka"}',
    reason: 'added-quotes',
  },
  {
    why: 'identical to source — model did not translate',
    raw: '{"name":"Chicken breast","storageHint":"Lodówka"}',
    reason: 'identical-to-source',
  },
  {
    why: 'invented digits (300 kcal appeared from nowhere)',
    raw: '{"name":"Pierś z kurczaka 300 kcal","storageHint":"Lodówka"}',
    reason: 'invented-digits',
  },
  {
    why: 'dramatic length blow-up',
    raw:
      '{"name":"Pierś z kurczaka (informacje o produkcie podane w bardzo długim ' +
      'opisie który ciągnie się i ciągnie i jest absurdalnie długi w stosunku do oryginału)",' +
      '"storageHint":"Lodówka"}',
    reason: 'length-blowup',
  },
  {
    why: 'mostly untranslated — English stopwords leak through',
    raw: '{"name":"The chicken with the breast","storageHint":"In the fridge"}',
    reason: 'untranslated',
  },
];

const ACCEPTED: { why: string; raw: string }[] = [
  {
    why: 'clean valid JSON, both fields translated',
    raw: '{"name":"Pierś z kurczaka","storageHint":"Przechowuj w lodówce"}',
  },
  {
    why: 'JSON wrapped in a markdown fence',
    raw: '```json\n{"name":"Pierś z kurczaka","storageHint":"Przechowuj w lodówce"}\n```',
  },
  {
    why: 'leading whitespace + trailing newline',
    raw: '   {"name":"Pierś z kurczaka","storageHint":"Przechowuj w lodówce"}\n\n',
  },
  {
    why: 'translation preserves source digits (no inventing)',
    raw: '{"name":"Pierś z kurczaka","storageHint":"Użyj w 2 dni"}',
  },
];

describe('extractJson', () => {
  it('strips a markdown fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips prose around the JSON', () => {
    expect(extractJson('Here you go: {"a":1} done.')).toBe('{"a":1}');
  });
  it('returns the raw input when already plain JSON', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe('validate — rejected', () => {
  for (const c of REJECTED) {
    it(`rejects: ${c.why}`, () => {
      const result = validate({
        source: SOURCE_PL,
        targetLocale: 'pl',
        rawOutput: c.raw,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(c.reason);
    });
  }
});

describe('validate — accepted', () => {
  for (const c of ACCEPTED) {
    it(`accepts: ${c.why}`, () => {
      const result = validate({
        source: SOURCE_PL,
        targetLocale: 'pl',
        rawOutput: c.raw,
      });
      expect(result.ok).toBe(true);
      expect(result.translations).toMatchObject({
        name: expect.any(String),
        storageHint: expect.any(String),
      });
    });
  }
});

describe('validate — passthrough tokens', () => {
  it("doesn't flag 'g' as identical-to-source (it's a unit symbol)", () => {
    const result = validate({
      source: { unit: 'g' },
      targetLocale: 'pl',
      rawOutput: '{"unit":"g"}',
    });
    expect(result.ok).toBe(true);
  });

  it("doesn't flag a number as identical-to-source", () => {
    const result = validate({
      source: { n: '100' },
      targetLocale: 'pl',
      rawOutput: '{"n":"100"}',
    });
    expect(result.ok).toBe(true);
  });
});
