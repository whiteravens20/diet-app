// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { clientDate } from './client-date.decorator.js';

describe('the day of a request', () => {
  const lateEvening = new Date('2026-03-01T23:30:00Z');

  it('is left to the server when the client names none', () => {
    expect(clientDate(undefined, lateEvening)).toBeNull();
  });

  it('is the one the client names: the server\'s, the day before or the day after', () => {
    expect(clientDate('2026-03-01', lateEvening)).toBe('2026-03-01');
    // Half past midnight in Warsaw, half past eight in the morning in Tokyo.
    expect(clientDate('2026-03-02', lateEvening)).toBe('2026-03-02');
    // Half past noon in Honolulu on the first is the small hours of the second in UTC.
    expect(clientDate('2026-02-28', new Date('2026-03-01T00:30:00Z'))).toBe('2026-02-28');
    expect(clientDate('2027-01-01', new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
  });

  it.each(['2026-03-03', '2026-02-27', '2025-03-01', '9999-12-31'])('is not %s, which it is nowhere on that evening', (named) => {
    expect(() => clientDate(named, lateEvening)).toThrow(BadRequestException);
  });

  it.each(['', 'today', '2026-3-1', '01.03.2026', '2026-02-30', '2026-13-01', '2026-03-01T00:00:00Z'])('is not %j, which is no day', (named) => {
    expect(() => clientDate(named, new Date('2026-03-01T12:00:00Z'))).toThrow(BadRequestException);
  });

  it('is not a header that was sent twice', () => {
    expect(() => clientDate(['2026-03-01', '2026-03-02'], lateEvening)).toThrow(BadRequestException);
  });

  it('says in the refusal which days would do', () => {
    try {
      clientDate('2026-03-09', lateEvening);
      expect.unreachable();
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({ error: 'VALIDATION_FAILED', issues: [{ path: 'x-client-date', message: expect.stringContaining('2026-03-01') }] });
    }
  });
});
