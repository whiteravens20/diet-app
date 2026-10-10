// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { waitOf } from './api';

describe('how long a request that was held up has to wait', () => {
  it('is given in whole minutes, rounded up, when it is long', () => {
    expect(waitOf(429, 900)).toEqual({ unit: 'minutes', count: 15 });
    expect(waitOf(429, 91)).toEqual({ unit: 'minutes', count: 2 });
  });

  it('is given in seconds up to a minute and a half', () => {
    expect(waitOf(429, 30)).toEqual({ unit: 'seconds', count: 30 });
    expect(waitOf(429, 90)).toEqual({ unit: 'seconds', count: 90 });
    expect(waitOf(429, 0.4)).toEqual({ unit: 'seconds', count: 1 });
  });

  it('is not given for a wait nobody stated or for another refusal', () => {
    expect(waitOf(429, undefined)).toBeNull();
    expect(waitOf(503, 900)).toBeNull();
  });
});
