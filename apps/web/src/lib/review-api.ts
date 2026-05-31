/**
 * Reviewer API client (Phase H).
 *
 * Cookie-based — `fetch` is called with `credentials: 'include'` so the
 * `reviewer_session` httpOnly cookie set by the backend rides along. No
 * sessionStorage; the cookie is the single source of identity. EN is rejected
 * at the API; this client never sends it.
 */
import type {
  IngredientNameReviewSlice,
  Locale,
  RecipeReviewSlice,
  ReviewerSessionDto,
} from '@diet-app/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export class ReviewApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewApiError';
  }
}

async function reviewFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/review${path}`, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch {
    throw new ReviewApiError(0, null, 'Cannot reach the API.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ReviewApiError(
      res.status,
      body.error ?? null,
      body.message ?? body.error ?? res.statusText,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

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
