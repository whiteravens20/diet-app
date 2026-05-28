import { Palette } from '@diet-app/shared';

/**
 * Palette resolution mirrors locale resolution: server reads a cookie on every
 * request and bakes `data-palette="..."` onto `<html>` so first paint is
 * already in the right colours; the client provider keeps the cookie + the
 * `<html>` attribute in sync when the user picks a new one. Authenticated
 * visitors additionally persist via `PATCH /users/me { palette }` so the
 * choice follows them across devices.
 *
 * The single source of truth for "which palettes exist" is the `Palette` enum
 * in `@diet-app/shared`; the picker and CSS blocks both derive from it.
 */
export const PALETTE_COOKIE = 'NEXT_PALETTE';
export const DEFAULT_PALETTE: Palette = 'default';
export const SUPPORTED_PALETTES = Palette.options;

export function isSupportedPalette(value: string | undefined | null): value is Palette {
  return typeof value === 'string' && (SUPPORTED_PALETTES as readonly string[]).includes(value);
}
