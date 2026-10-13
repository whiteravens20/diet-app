// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What an account chose, as its row holds it. The columns are plain text, so
 * a row can hold a value this version does not know: a language or a palette
 * a later version dropped, or one written by hand. Such a value is read as
 * the choice an account has before it chooses, and the account goes on
 * working; reading it strictly would answer every request of the account
 * with an error.
 */
import { AiMode, Locale, Palette, Theme, WeightUnit } from '@diet-app/shared';

export const storedLocale = (value: string | null | undefined): Locale => Locale.catch('en').parse(value);
export const storedTheme = (value: string | null | undefined): Theme => Theme.catch('system').parse(value);
export const storedPalette = (value: string | null | undefined): Palette => Palette.catch('default').parse(value);
export const storedAiMode = (value: string | null | undefined): AiMode => AiMode.catch('none').parse(value);
export const storedWeightUnit = (value: string | null | undefined): WeightUnit | null => WeightUnit.nullable().catch(null).parse(value ?? null);
