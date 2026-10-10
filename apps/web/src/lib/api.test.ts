// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { ApiClientError, minutesToWait } from './api';

describe('how long a request that was held up has to wait', () => {
  const heldUp = (seconds?: number, status = 429): ApiClientError =>
    new ApiClientError(status, 'RATE_LIMITED', 'Too many requests.', undefined, seconds);

  it('is given in whole minutes, rounded up', () => {
    expect(minutesToWait(heldUp(900))).toBe(15);
    expect(minutesToWait(heldUp(61))).toBe(2);
  });

  it('is not given for a moment, for a wait nobody stated or for another refusal', () => {
    expect(minutesToWait(heldUp(60))).toBeNull();
    expect(minutesToWait(heldUp())).toBeNull();
    expect(minutesToWait(heldUp(900, 503))).toBeNull();
  });
});
