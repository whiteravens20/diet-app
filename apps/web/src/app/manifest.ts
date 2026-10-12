// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MetadataRoute } from 'next';

/**
 * What the application is to a browser that installs it. The icons are made
 * from the one drawing, `public/icon.svg`, by `scripts/make-icons.mjs`: a
 * browser asks for bitmaps of these sizes before it offers to install.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Diet App',
    short_name: 'Diet App',
    description: 'Calorie-targeted meal planning with deterministic nutrition.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1a201c',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
