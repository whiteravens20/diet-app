// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Curated, free-license food photography committed under
 * `apps/web/public/imagery` (no runtime third-party fetches, so the app stays
 * self-hostable). Attribution for each photo lives in
 * `apps/web/public/imagery/CREDITS.md`. Reference images by these keys so paths
 * stay in one place.
 */
export const IMAGERY = {
  dashboard: '/imagery/dashboard.webp',
  diary: '/imagery/diary.webp',
  favorites: '/imagery/favorites.webp',
  mealPlans: '/imagery/meal-plans.webp',
  recipes: '/imagery/recipes.webp',
  shopping: '/imagery/shopping.webp',
  inventory: '/imagery/inventory.webp',
  profile: '/imagery/profile.webp',
  calculator: '/imagery/calculator.webp',
  settings: '/imagery/settings.webp',
  // Distinct photos for empty states, so they don't echo the page banner.
  emptyDashboard: '/imagery/empty-dashboard.webp',
  emptyMealPlans: '/imagery/empty-meal-plans.webp',
  emptyInventory: '/imagery/empty-inventory.webp',
} as const;
