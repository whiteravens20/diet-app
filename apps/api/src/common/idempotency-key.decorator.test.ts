// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { idempotencyKey } from './idempotency-key.decorator.js';

describe("an addition's key", () => {
  it('is none when the client sends none', () => {
    expect(idempotencyKey(undefined)).toBeNull();
  });

  it('is the one the client sends, quoted as the IETF draft writes it or not', () => {
    const uuid = '8e03978e-40d5-43e8-bc93-6894a57f9324';
    expect(idempotencyKey(uuid)).toBe(uuid);
    expect(idempotencyKey(`"${uuid}"`)).toBe(uuid);
    expect(idempotencyKey(` ${uuid} `)).toBe(uuid);
    expect(idempotencyKey('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it.each([
    ['', 'nothing'],
    ['""', 'nothing quoted'],
    ['a'.repeat(129), 'too long'],
    ['one two', 'a space'],
    ['klucz-ż', 'a letter outside ASCII'],
  ])('is not %j, which holds %s', (sent) => {
    expect(() => idempotencyKey(sent)).toThrow(BadRequestException);
  });

  it('is not a header sent twice', () => {
    expect(() => idempotencyKey(['one', 'two'])).toThrow(BadRequestException);
  });
});
