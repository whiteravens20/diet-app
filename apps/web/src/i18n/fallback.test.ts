// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { withEnglishUnder } from './fallback';

describe('the texts of a language with the English ones under them', () => {
  const english = {
    common: { save: 'Save', cancel: 'Cancel' },
    plans: { day: { title: 'Day {n}', empty: 'Nothing planned' } },
    title: 'Diet App',
  };

  it("keep the language's own texts and take a missing one from English, at any depth", () => {
    const merged = withEnglishUnder(english, {
      common: { save: 'Zapisz' },
      plans: { day: { title: 'Dzień {n}' } },
    });

    expect(merged).toEqual({
      common: { save: 'Zapisz', cancel: 'Cancel' },
      plans: { day: { title: 'Dzień {n}', empty: 'Nothing planned' } },
      title: 'Diet App',
    });
  });

  it('are the English texts for a language that has none, and leave both as they were', () => {
    const own = {};

    expect(withEnglishUnder(english, own)).toEqual(english);
    expect(own).toEqual({});
    expect(english.common).toEqual({ save: 'Save', cancel: 'Cancel' });
  });
});
