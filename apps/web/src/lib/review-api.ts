// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Reviewer API client.
 *
 * Cookie-based: the `reviewer_session` httpOnly cookie the backend set goes
 * with every request, and is the single source of identity. EN is rejected
 * at the API; this client never sends it.
 */
import type {
  IngredientNameReviewSlice,
  Locale,
  RecipeReviewSlice,
  ReviewerSessionDto,
} from '@diet-app/shared';

import { apiClient } from './http';

const reviewFetch = apiClient('/review').request;

export interface ReviewStatusDto {
  enabled: boolean;
  passwordSet: boolean;
  locales: Locale[];
}

export interface ReviewerListPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const reviewApi = {
  status: () => reviewFetch<ReviewStatusDto>('/status'),
  session: () => reviewFetch<{ session: ReviewerSessionDto | null }>('/session'),
  login: (body: { password: string; label: string }) =>
    reviewFetch<void>('/auth', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => reviewFetch<void>('/auth/logout', { method: 'POST' }),

  listRecipeSlices: (
    locale: Locale,
    opts: { includeReviewed?: boolean; page?: number; pageSize?: number } = {},
  ) => {
    const params = new URLSearchParams({ locale });
    if (opts.includeReviewed) params.set('includeReviewed', 'true');
    if (opts.page) params.set('page', String(opts.page));
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
    return reviewFetch<ReviewerListPage<RecipeReviewSlice>>(
      `/drafts/recipes?${params.toString()}`,
    );
  },
  getRecipeSlice: (locale: Locale, id: string) =>
    reviewFetch<RecipeReviewSlice>(
      `/drafts/recipes/${id}?locale=${encodeURIComponent(locale)}`,
    ),
  patchRecipeSlice: (
    locale: Locale,
    id: string,
    body: { title?: string; description?: string; steps?: string[] },
  ) =>
    reviewFetch<RecipeReviewSlice>(
      `/drafts/recipes/${id}?locale=${encodeURIComponent(locale)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  approveRecipe: (locale: Locale, id: string, reason?: string) =>
    reviewFetch<RecipeReviewSlice>(
      `/drafts/recipes/${id}/approve?locale=${encodeURIComponent(locale)}`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    ),
  rejectRecipe: (locale: Locale, id: string, reason?: string) =>
    reviewFetch<RecipeReviewSlice>(
      `/drafts/recipes/${id}/reject?locale=${encodeURIComponent(locale)}`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    ),

  listIngredientNameSlices: (
    locale: Locale,
    opts: { includeReviewed?: boolean; page?: number; pageSize?: number } = {},
  ) => {
    const params = new URLSearchParams({ locale });
    if (opts.includeReviewed) params.set('includeReviewed', 'true');
    if (opts.page) params.set('page', String(opts.page));
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
    return reviewFetch<ReviewerListPage<IngredientNameReviewSlice>>(
      `/drafts/ingredient-names?${params.toString()}`,
    );
  },
  patchIngredientNameSlice: (
    locale: Locale,
    id: string,
    body: { name?: string; storageHint?: string },
  ) =>
    reviewFetch<IngredientNameReviewSlice>(
      `/drafts/ingredient-names/${id}?locale=${encodeURIComponent(locale)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  approveIngredientName: (locale: Locale, id: string, reason?: string) =>
    reviewFetch<IngredientNameReviewSlice>(
      `/drafts/ingredient-names/${id}/approve?locale=${encodeURIComponent(locale)}`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    ),
  rejectIngredientName: (locale: Locale, id: string, reason?: string) =>
    reviewFetch<IngredientNameReviewSlice>(
      `/drafts/ingredient-names/${id}/reject?locale=${encodeURIComponent(locale)}`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    ),
};
