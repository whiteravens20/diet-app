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
 * Colour palette family — orthogonal to `Theme` (which only controls
 * light/dark mode). Each palette ships both a light and a dark variant in
 * `apps/web/src/app/globals.css`; the active variant is picked by the
 * `.dark` class plus the `data-palette` attribute on `<html>`.
 *
 * Adding a new palette is a 2-step recipe: extend this enum, then drop the
 * `:root[data-palette="<name>"]` + `.dark[data-palette="<name>"]` blocks in
 * `globals.css`. The settings picker iterates this enum automatically.
 */
export const Palette = z.enum([
  'default',
  'ocean',
  'forest',
  'sunset',
  'mono',
  'rose',
]);
export type Palette = z.infer<typeof Palette>;

/**
 * Per-user AI mode (F10):
 * - `none`  — every AI feature falls back to the deterministic engine and no
 *             provider call ever leaves the instance.
 * - `admin` — the user borrows the operator's configured provider
 *             (`AI_DEFAULT_PROVIDER` / `AI_DEFAULT_MODEL`), capped by
 *             `AI_ADMIN_USER_MONTHLY_LIMIT` rolling-30-day requests.
 * - `byok`  — the user supplies their own API key / Ollama URL via
 *             `AiProviderConfig`; no quota, no admin failover.
 *
 * Default is `none` so a fresh account never makes outbound AI calls until
 * the user opts in from Settings.
 */
export const AiMode = z.enum(['none', 'admin', 'byok']);
export type AiMode = z.infer<typeof AiMode>;

/**
 * `AuthUser` extended with the user-controlled preference fields. Returned by
 * `GET /users/me` and by every settings-mutation endpoint.
 */
export const SessionUser = AuthUser.extend({
  locale: Locale,
  theme: Theme,
  palette: Palette,
  aiMode: AiMode,
});
export type SessionUser = z.infer<typeof SessionUser>;

export const UpdateUserSettings = z.object({
  displayName: z.string().min(1).max(80).optional(),
  locale: Locale.optional(),
  theme: Theme.optional(),
  palette: Palette.optional(),
  aiMode: AiMode.optional(),
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

/**
 * Requests a change of the account email. Only available when the instance has
 * SMTP configured — a confirmation link is sent to the new address, and the
 * change only takes effect once that link is followed.
 */
export const ChangeEmailRequest = z.object({
  newEmail: z.string().email(),
  currentPassword: z.string().min(1).max(128),
});
export type ChangeEmailRequest = z.infer<typeof ChangeEmailRequest>;
