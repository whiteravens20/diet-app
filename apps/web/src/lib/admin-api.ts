/**
 * Admin API client (F16). Uses HTTP Basic against `/api/admin/*` — totally
 * separate identity space from the user JWT used by `lib/api.ts`. Credentials
 * live in sessionStorage so they vanish when the tab closes; never persisted
 * across browser sessions.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const CREDS_KEY = 'diet-app.admin-basic';

export const adminCreds = {
  get(): string | null {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem(CREDS_KEY);
  },
  set(user: string, password: string): void {
    sessionStorage.setItem(CREDS_KEY, btoa(`${user}:${password}`));
  },
  clear(): void {
    sessionStorage.removeItem(CREDS_KEY);
  },
};

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

async function adminFetch<T>(
  path: string,
  init: RequestInit = {},
  withAuth = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (withAuth) {
    const creds = adminCreds.get();
    if (creds) headers.set('authorization', `Basic ${creds}`);
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/admin${path}`, { ...init, headers });
  } catch {
    throw new AdminApiError(0, 'Cannot reach the API.');
  }

  if (res.status === 401) {
    adminCreds.clear();
    throw new AdminApiError(401, 'Invalid admin credentials.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new AdminApiError(res.status, body.message ?? body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface AdminStatus {
  enabled: boolean;
  message: string | null;
}

export interface AdminStats {
  counts: { ingredients: number; recipes: number; substitutions: number };
  seed: {
    lastSeededAt: string | null;
    storedHash: string | null;
    currentHash: string;
    updateAvailable: boolean;
    files: { name: string; present: boolean; bytes: number }[];
  };
}

export interface DbUpdateResult {
  deletedRecipes: number;
  deletedIngredients: number;
  counts: { ingredients: number; recipes: number; substitutions: number };
  hash: string;
  seededAt: string;
}

export type DbUpdateStatus = 'idle' | 'running' | 'done' | 'error';

/** Mirrors `RunnerState` on the API. */
export interface DbUpdateState {
  status: DbUpdateStatus;
  startedAt: string | null;
  finishedAt: string | null;
  stage: string | null;
  current: number | null;
  total: number | null;
  result: DbUpdateResult | null;
  error: string | null;
}

export type UsdaImportStatus = 'idle' | 'running' | 'done' | 'error';

export interface UsdaImportRunnerState {
  status: UsdaImportStatus;
  startedAt: string | null;
  finishedAt: string | null;
  page: number | null;
  totalPages: number | null;
  kept: number;
  skipped: number;
  excluded: number;
  dataTypes: string | null;
  demoKey: boolean;
  result: {
    kept: number;
    skipped: number;
    excluded: number;
    totalPages: number;
    outFile: string;
    dataTypes: string;
    demoKey: boolean;
  } | null;
  error: string | null;
}

// ── Curation queue (drafts) ───────────────────────────────────────────────────

export interface DraftLocaleReview {
  locale: string;
  action: 'APPROVE' | 'REJECT';
  reviewedByLabel: string;
  reason: string | null;
  reviewedAt: string;
}

export interface IngredientNameSuggestionMap {
  name: Record<string, string>;
  storageHint?: Record<string, string>;
}

export interface IngredientNameDraft {
  id: string;
  ingredientId: string | null;
  ingredientSlug: string;
  rawDescription: string;
  suggestions: IngredientNameSuggestionMap;
  locales: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';
  source: 'AI' | 'EXTERNAL' | 'MANUAL' | 'AI_USER';
  batchId: string;
  modelUsed: string | null;
  generatorPrompt: string | null;
  shippedPRUrl: string | null;
  shippedAt: string | null;
  createdAt: string;
  updatedAt: string;
  localeReviews: DraftLocaleReview[];
}

export interface DraftRunnerState {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: string | null;
  finishedAt: string | null;
  processed: number;
  total: number;
  failed: number;
  written: number;
  provider: string | null;
  model: string | null;
  batchId: string | null;
  error: string | null;
  configured: boolean;
}

export interface IngredientNameGenerateSpec {
  scope: 'all-usda-missing' | 'specific-slugs';
  slugs?: string[];
  targetLocales?: string[];
}

// ── Recipe drafts (Phase D) ───────────────────────────────────────────────────

export type RecipeComplexity = 'simple' | 'medium' | 'complex';

export interface RecipeDraftIngredientLine {
  slug: string;
  quantity: number;
  unit: 'g' | 'ml' | 'piece';
  note?: string | null;
}

export interface RecipeDraft {
  id: string;
  slug: string;
  titles: Record<string, string>;
  descriptions: Record<string, string>;
  steps: Record<string, string[]>;
  locales: string[];
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  complexity: RecipeComplexity;
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  allergens: string[];
  ingredients: RecipeDraftIngredientLine[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';
  source: 'AI' | 'EXTERNAL' | 'MANUAL' | 'AI_USER';
  batchId: string;
  modelUsed: string | null;
  generatorPrompt: string | null;
  generationSpec: unknown;
  provenanceUrl: string | null;
  provenanceLicense: string | null;
  shippedPRUrl: string | null;
  shippedAt: string | null;
  createdAt: string;
  updatedAt: string;
  localeReviews: DraftLocaleReview[];
}

export interface RecipeGenerateSpec {
  count: number;
  targetLocales?: string[];
  catalogueScope?: 'curated' | 'all';
  dietTags?: string[];
  mealTypes?: string[];
  cuisine?: string;
  kcalRange?: { min: number; max: number };
  avoidSlugs?: string[];
  preferSlugs?: string[];
  complexityMix?: { simple: number; medium: number; complex: number };
}

export interface RecipeDraftPatch {
  titles?: Record<string, string>;
  descriptions?: Record<string, string>;
  steps?: Record<string, string[]>;
  servings?: number;
  mealTypes?: string[];
  dietTags?: string[];
  prepMinutes?: number;
  cookMinutes?: number;
  difficulty?: 'easy' | 'medium' | 'hard';
  ingredients?: RecipeDraftIngredientLine[];
}

export interface RecipeRunnerState extends DraftRunnerState {
  complexityCounts: { simple: number; medium: number; complex: number };
  mixDrift: boolean;
  lastRejectReason: string | null;
  lastRejectKey: string | null;
  lastRejectHead: string | null;
}

export interface PagedDrafts<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const adminApi = {
  status: () => adminFetch<AdminStatus>('/status', {}, false),
  stats: () => adminFetch<AdminStats>('/stats'),
  startDbUpdate: () => adminFetch<DbUpdateState>('/db/update', { method: 'POST' }),
  dbUpdateStatus: () => adminFetch<DbUpdateState>('/db/update/status'),
  startUsdaImport: (dataTypes?: string) =>
    adminFetch<UsdaImportRunnerState>(
      `/db/import-usda${dataTypes ? `?dataTypes=${encodeURIComponent(dataTypes)}` : ''}`,
      { method: 'POST' },
    ),
  usdaImportStatus: () =>
    adminFetch<UsdaImportRunnerState>('/db/import-usda/status'),

  // Drafts: ingredient-name
  startIngredientNamer: (spec: IngredientNameGenerateSpec) =>
    adminFetch<DraftRunnerState>('/drafts/ingredient-names/generate', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),
  ingredientNamerStatus: () =>
    adminFetch<DraftRunnerState>('/drafts/ingredient-names/generate/status'),
  stopIngredientNamer: () =>
    adminFetch<DraftRunnerState>('/drafts/ingredient-names/generate/stop', {
      method: 'POST',
    }),
  listIngredientNameDrafts: (params: {
    status?: string;
    batchId?: string;
    page?: number;
    pageSize?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.batchId) q.set('batchId', params.batchId);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    const qs = q.toString();
    return adminFetch<PagedDrafts<IngredientNameDraft>>(
      `/drafts/ingredient-names${qs ? `?${qs}` : ''}`,
    );
  },
  patchIngredientNameDraft: (id: string, suggestions: IngredientNameSuggestionMap) =>
    adminFetch<IngredientNameDraft>(`/drafts/ingredient-names/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ suggestions }),
    }),
  approveIngredientNameDraft: (
    id: string,
    locale: string,
    reviewedByLabel: string,
  ) =>
    adminFetch<IngredientNameDraft>(
      `/drafts/ingredient-names/${id}/approve?locale=${encodeURIComponent(locale)}`,
      { method: 'POST', body: JSON.stringify({ reviewedByLabel }) },
    ),
  rejectIngredientNameDraft: (
    id: string,
    locale: string,
    reviewedByLabel: string,
    reason?: string,
  ) =>
    adminFetch<IngredientNameDraft>(
      `/drafts/ingredient-names/${id}/reject?locale=${encodeURIComponent(locale)}`,
      { method: 'POST', body: JSON.stringify({ reviewedByLabel, reason }) },
    ),
  deleteIngredientNameDraft: (id: string) =>
    adminFetch<void>(`/drafts/ingredient-names/${id}`, { method: 'DELETE' }),

  // Drafts: recipes
  startRecipeGenerator: (spec: RecipeGenerateSpec) =>
    adminFetch<RecipeRunnerState>('/drafts/recipes/generate', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),
  recipeGeneratorStatus: () =>
    adminFetch<RecipeRunnerState>('/drafts/recipes/generate/status'),
  stopRecipeGenerator: () =>
    adminFetch<RecipeRunnerState>('/drafts/recipes/generate/stop', { method: 'POST' }),
  listRecipeDrafts: (params: {
    status?: string;
    batchId?: string;
    complexity?: string;
    page?: number;
    pageSize?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.batchId) q.set('batchId', params.batchId);
    if (params.complexity) q.set('complexity', params.complexity);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    const qs = q.toString();
    return adminFetch<PagedDrafts<RecipeDraft>>(
      `/drafts/recipes${qs ? `?${qs}` : ''}`,
    );
  },
  getRecipeDraft: (id: string) =>
    adminFetch<RecipeDraft>(`/drafts/recipes/${id}`),
  patchRecipeDraft: (id: string, patch: RecipeDraftPatch, dryRun = false) =>
    adminFetch<RecipeDraft>(
      `/drafts/recipes/${id}${dryRun ? '?dryRun=true' : ''}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  approveRecipeDraft: (id: string, locale: string, reviewedByLabel: string) =>
    adminFetch<RecipeDraft>(
      `/drafts/recipes/${id}/approve?locale=${encodeURIComponent(locale)}`,
      { method: 'POST', body: JSON.stringify({ reviewedByLabel }) },
    ),
  rejectRecipeDraft: (id: string, locale: string, reviewedByLabel: string, reason?: string) =>
    adminFetch<RecipeDraft>(
      `/drafts/recipes/${id}/reject?locale=${encodeURIComponent(locale)}`,
      { method: 'POST', body: JSON.stringify({ reviewedByLabel, reason }) },
    ),
  deleteRecipeDraft: (id: string) =>
    adminFetch<void>(`/drafts/recipes/${id}`, { method: 'DELETE' }),
  promoteRecipeDraft: (id: string) =>
    adminFetch<RecipeDraft>(`/drafts/recipes/${id}/promote`, { method: 'POST' }),

  // Ship
  shipConfig: () => adminFetch<ShipConfigDto>('/drafts/ship/config'),
  ship: (body: ShipRequest) =>
    adminFetch<ShipResponse>('/drafts/ship', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  shipMarkShipped: (body: ShipMarkShippedRequest) =>
    adminFetch<{ updated: number }>('/drafts/ship/mark-shipped', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Instance settings (Phase H) — reviewer-interface toggle + password.
  instanceSettings: () => adminFetch<InstanceSettingsDto>('/instance-settings'),
  patchInstanceSettings: (body: InstanceSettingsPatchPayload) =>
    adminFetch<InstanceSettingsDto>('/instance-settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};

export interface InstanceSettingsDto {
  reviewerEnabled: boolean;
  reviewerPasswordSet: boolean;
  updatedAt: string;
}

export interface InstanceSettingsPatchPayload {
  reviewerEnabled?: boolean;
  /** Empty string clears the existing hash; `undefined` means "no change". */
  reviewerPassword?: string;
}

export type ShipKind = 'recipe' | 'ingredient-name';
export type ShipMode = 'local' | 'upstream-pr' | 'bundle';

export interface ShipConfigDto {
  modes: {
    local: { available: true };
    upstreamPr: {
      available: boolean;
      enabled: boolean;
      reason: string | null;
      baseBranch: string;
      remote: string;
    };
    bundle: { available: true; ttlSeconds: number };
  };
  approvedCounts: { recipe: number; ingredientName: number };
}

export interface ShipRequest {
  kind: ShipKind;
  mode: ShipMode;
  batchIds?: string[];
}

export interface ShipMarkShippedRequest {
  kind: ShipKind;
  draftIds: string[];
}

export type ShipResponse =
  | {
      mode: 'local';
      kind: ShipKind;
      shippedDraftIds: string[];
      skipped: { draftId: string; reason: string }[];
      sidecarPaths: string[];
    }
  | {
      mode: 'upstream-pr';
      prUrl: string;
      branch: string;
      shippedDraftIds: string[];
      skipped: { draftId: string; reason: string }[];
    }
  | {
      mode: 'bundle';
      downloadUrl: string;
      token: string;
      expiresAt: string;
      draftIds: string[];
    };
