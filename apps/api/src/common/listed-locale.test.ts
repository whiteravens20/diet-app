// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException } from '@nestjs/common';
import { LOCALES, type Locale } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { listedLocale } from './listed-locale.js';

describe('a language a request names', () => {
  it('goes on as the list holds it', () => {
    for (const locale of LOCALES) expect(listedLocale(locale)).toBe(locale);
  });

  it('is refused when the list does not hold it, as the validation of the request would', () => {
    for (const other of ['__proto__', 'constructor', 'de', '../en', 'PL', ''])
      expect(() => listedLocale(other as Locale)).toThrow(BadRequestException);
  });
});
