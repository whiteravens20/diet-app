// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

// A picture of a document, which has no text in place of it as a page's has.
import { Font, Image as PdfPicture } from '@react-pdf/renderer';

/*
 * What the application's documents share: their typeface and the mark at
 * their head. Only the modules that make a document import this, and the
 * page fetches those when a document is asked for, so @react-pdf never ships
 * with a page.
 *
 * The default @react-pdf built-in fonts (Helvetica/Times/Courier) cover only
 * basic Latin and mangle Polish diacritics. We register Inter from /public,
 * the complete files (public/fonts/CREDITS.md), so a document is set in one
 * typeface without any third-party font CDN call at runtime — important for
 * offline self-hosted instances. A character the files lack is drawn in a
 * built-in font, one character at a time: pdf-fonts.test.ts holds the files
 * to every character the application writes.
 *
 * Registration is deferred + absolute-URL because @react-pdf internally
 * `fetch()`es the src at render time; with a relative path the resolution
 * is not always what you'd expect inside a bundler-emitted module.
 * Idempotent: registering twice with the same family is a no-op.
 */
let fontRegistered = false;
export function ensureFontRegistered(): void {
  if (fontRegistered || typeof window === 'undefined') return;
  const origin = window.location.origin;
  Font.register({
    family: 'Inter',
    fonts: [
      { src: `${origin}/fonts/Inter-Regular.ttf`, fontWeight: 400 },
      { src: `${origin}/fonts/Inter-Bold.ttf`, fontWeight: 700 },
    ],
  });
  fontRegistered = true;
}

/** The application's icon, as the sidebar shows it, fetched from the instance as the typeface is. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <PdfPicture
      src={`${window.location.origin}/icon-192.png`}
      style={{ width: size, height: size, borderRadius: size * 0.2 }}
    />
  );
}
