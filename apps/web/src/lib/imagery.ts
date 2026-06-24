/**
 * F19.1 — curated, free-license food photography committed under
 * `apps/web/public/imagery` (no runtime third-party fetches, so the app stays
 * self-hostable). Attribution for each photo lives in
 * `apps/web/public/imagery/CREDITS.md`. Reference images by these keys so paths
 * stay in one place.
 */
export const IMAGERY = {
  dashboard: '/imagery/dashboard.webp',
  mealPlans: '/imagery/meal-plans.webp',
  recipes: '/imagery/recipes.webp',
  shopping: '/imagery/shopping.webp',
  inventory: '/imagery/inventory.webp',
  // Distinct photos for empty states, so they don't echo the page banner.
  emptyDashboard: '/imagery/empty-dashboard.webp',
  emptyMealPlans: '/imagery/empty-meal-plans.webp',
  emptyInventory: '/imagery/empty-inventory.webp',
} as const;

export type ImageryKey = keyof typeof IMAGERY;
