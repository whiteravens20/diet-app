import { z } from 'zod';
import { AuthUser, newPassword } from './auth.js';

/**
 * Supported UI locales. The single source of truth for "which locales the app
 * speaks" — the API derives the locale list from this enum, the admin
 * translation-status card iterates over it, and adding a new locale starts
 * with extending this enum.
 *
 * `en` is the canonical source language. Translations are stored per
 * non-canonical locale in `IngredientTranslation` / `RecipeTranslation`.
 */
export const Locale = z.enum(['en', 'pl']);
export type Locale = z.infer<typeof Locale>;

/** All non-canonical locales — handy for "translate all" loops. */
export const NON_CANONICAL_LOCALES = Locale.options.filter((l) => l !== 'en');

export const Theme = z.enum(['light', 'dark', 'system']);
export type Theme = z.infer<typeof Theme>;

/**
 * `AuthUser` extended with the user-controlled preference fields. Returned by
 * `GET /users/me` and by every settings-mutation endpoint.
 */
export const SessionUser = AuthUser.extend({
  locale: Locale,
  theme: Theme,
});
export type SessionUser = z.infer<typeof SessionUser>;

export const UpdateUserSettings = z.object({
  displayName: z.string().min(1).max(80).optional(),
  locale: Locale.optional(),
  theme: Theme.optional(),
});
export type UpdateUserSettings = z.infer<typeof UpdateUserSettings>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const DeleteAccountRequest = z.object({
  currentPassword: z.string().min(1).max(128),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;
