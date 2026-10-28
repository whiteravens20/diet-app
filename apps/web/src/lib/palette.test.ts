// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, isSupportedPalette, SUPPORTED_PALETTES } from './palette';

describe('the palette a cookie names', () => {
  it('is taken where the application has it', () => {
    for (const palette of SUPPORTED_PALETTES) expect(isSupportedPalette(palette)).toBe(true);
    expect(isSupportedPalette(DEFAULT_PALETTE)).toBe(true);
  });

  it('is not taken where the application has no such palette, or the cookie names none', () => {
    expect(isSupportedPalette('neon')).toBe(false);
    expect(isSupportedPalette(null)).toBe(false);
  });
});
