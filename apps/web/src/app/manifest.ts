import type { MetadataRoute } from 'next';

/** PWA manifest — enables install + offline shell (Phase 2 roadmap item). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Diet App',
    short_name: 'Diet App',
    description: 'Calorie-targeted meal planning with deterministic nutrition.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1a201c',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
