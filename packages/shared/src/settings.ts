// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { AuthUser, emailAddress, newPassword } from './auth.js';
import { LOCALES, PALETTES } from './options.js';

/**
 * Supported UI locales. The single source of truth for "which locales the app
 * speaks" — the API derives the locale list from this enum, the admin
 * translation-status card iterates over it, and adding a new locale starts
 * with adding it to `LOCALES` in `options.ts`, which this enum is built on.
 *
 * `en` is the canonical source language. Translations are stored per
 * non-canonical locale in `IngredientTranslation` / `RecipeTranslation`.
 */
export const Locale = z.enum(LOCALES);
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
 * Adding a new palette is a 2-step recipe: add it to `PALETTES` in
 * `options.ts`, which this enum is built on, then drop the
 * `:root[data-palette="<name>"]` + `.dark[data-palette="<name>"]` blocks in
 * `globals.css`. The settings picker iterates the list automatically.
 */
export const Palette = z.enum(PALETTES);
export type Palette = z.infer<typeof Palette>;

/**
 * Per-user AI mode:
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
 * The unit an account reads and types a body weight in. The API keeps and
 * answers every weight in kilograms; a client converts for whoever chose
 * pounds.
 */
export const WeightUnit = z.enum(['kg', 'lb']);
export type WeightUnit = z.infer<typeof WeightUnit>;

/**
 * `AuthUser` extended with the user-controlled preference fields. Returned by
 * `GET /users/me` and by every settings-mutation endpoint.
 */
export const SessionUser = AuthUser.extend({
  locale: Locale,
  theme: Theme,
  palette: Palette,
  aiMode: AiMode,
  /** Null until the account chooses: a client then goes by where its reader is (pounds in the few countries that weigh in them). */
  weightUnit: WeightUnit.nullable(),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const UpdateUserSettings = z.object({
  displayName: z.string().min(1).max(80).optional(),
  locale: Locale.optional(),
  theme: Theme.optional(),
  palette: Palette.optional(),
  aiMode: AiMode.optional(),
  /** Null gives the choice back to the client. */
  weightUnit: WeightUnit.nullable().optional(),
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
  newEmail: emailAddress,
  currentPassword: z.string().min(1).max(128),
});
export type ChangeEmailRequest = z.infer<typeof ChangeEmailRequest>;
