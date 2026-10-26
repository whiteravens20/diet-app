// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Admin API client for `/api/admin/*`: an identity of its own, apart from the
 * accounts `lib/api.ts` speaks for. The administrator signs in once, and the
 * session is a cookie the API set, which no script reads: the page holds no
 * credentials, and nothing here keeps a password.
 */
import type {
  AdminConnection,
  AdminOperatorAi,
  AdminSessionState,
  AdminStats,
  AdminStatus,
  CatalogueUpdateState,
  Cuisine,
  DraftRunnerState,
  FoodImportState,
  IngredientNameDraft,
  IngredientNameSuggestion,
  InstanceDataState,
  InstanceSettingsDto,
  LocaleReview,
  Macros,
  MealType,
  PastReview,
  RecipeDraft,
  RecipeDraftIngredientLine,
  RecipeImportResult,
  RecipeRunState,
  RestoredFromInstanceData,
  SecondFactorSetup,
  ShipConfig,
  ShipKind,
  ShipMode,
  ShipResult,
  SkippedDraft,
  StoredImportRejection,
} from '@diet-app/shared';
import { apiClient } from './http';

// What the API answers with is a type of the contract, under the name the panel has for it.
export type {
  AdminConnection,
  AdminOperatorAi,
  AdminStats,
  AdminStatus,
  DraftRunnerState,
  IngredientNameDraft,
  InstanceDataState,
  InstanceSettingsDto,
  RecipeDraft,
  RecipeDraftIngredientLine,
  ShipKind,
  ShipMode,
};
export type IngredientNameSuggestionMap = IngredientNameSuggestion;
export type DraftLocaleReview = LocaleReview;
export type DraftPastReview = PastReview;
export type RecipeRunnerState = RecipeRunState;
export type ShipConfigDto = ShipConfig;
export type RestoreResponse = RestoredFromInstanceData;
export type ShipSkipped = SkippedDraft;
export type ShipResponse = ShipResult;

// A version before this one kept the administrator's user and password in
// sessionStorage for the life of the tab. Whatever it left there is removed.
if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('diet-app.admin-basic');

// The session is the cookie, which the browser sends: nothing is added to a request.
const admin = apiClient('/admin');
const adminFetch = admin.request;

/** Shares of a day's energy, adding up to one. */
export type MacroShares = Macros;

/** Where the catalogue update stands. */
export type DbUpdateState = CatalogueUpdateState;

/** Where the import of foods stands. */
export type UsdaImportRunnerState = FoodImportState;

// ── Curation queue (drafts) ───────────────────────────────────────────────────

/** What an import is sent: a document of recipes, and what holds for a recipe of it that does not say so itself. */
export interface RecipeImportRequestInput {
  /** The text of the JSON document, as it was pasted or read from a file. */
  document: string;
  sourceUrl?: string;
  license?: string;
  mealTypes?: MealType[];
  /** Say what would come of the document, and write nothing. */
  dryRun: boolean;
}

export interface IngredientNameGenerateSpec {
  scope: 'all-usda-missing' | 'specific-slugs';
  slugs?: string[];
  targetLocales?: string[];
}

// ── Recipe drafts ─────────────────────────────────────────────────────────────

export interface RecipeGenerateSpec {
  count: number;
  targetLocales?: string[];
  catalogueScope?: 'curated' | 'all';
  /** Write for the diet and meal with the fewest recipes; `dietTags` and `mealTypes` may not be sent with it. */
  fillCoverage?: boolean;
  dietTags?: string[];
  mealTypes?: string[];
  cuisine?: string;
  kcalRange?: { min: number; max: number };
  avoidSlugs?: string[];
  preferSlugs?: string[];
  complexityMix?: { simple: number; medium: number; complex: number };
}

export interface RecipeDraftPatch {
  /** Sent alone, it leaves the reviews standing. */
  slug?: string;
  titles?: Record<string, string>;
  descriptions?: Record<string, string>;
  steps?: Record<string, string[]>;
  servings?: number;
  mealTypes?: string[];
  prepMinutes?: number;
  cookMinutes?: number;
  difficulty?: 'easy' | 'medium' | 'hard';
  /** Null takes the cuisine away. A change of it alone leaves the reviews standing. */
  cuisine?: Cuisine | null;
  ingredients?: RecipeDraftIngredientLine[];
}

/** A page of drafts. */
export interface PagedDrafts<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const adminApi = {
  status: () => adminFetch<AdminStatus>('/status'),
  /** Whether there is a panel, and whether this browser is signed in to it. */
  session: () => adminFetch<AdminSessionState>('/session'),
  /** Give the instance's user and password once, for the session, with a code where the administrator has a second factor. */
  signIn: (user: string, password: string, code?: string) =>
    adminFetch<void>('/session', {
      method: 'POST',
      body: JSON.stringify({ user, password, ...(code ? { code } : {}) }),
    }),
  /** A secret to set an authenticator app up with, for the password. */
  proposeSecondFactor: (password: string) =>
    adminFetch<SecondFactorSetup>('/session/second-factor/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  /** The first code from the app: signing in takes one from now on. */
  beginSecondFactor: (enrolment: string, code: string) =>
    adminFetch<void>('/session/second-factor', {
      method: 'POST',
      body: JSON.stringify({ enrolment, code }),
    }),
  endSecondFactor: (password: string, code: string) =>
    adminFetch<void>('/session/second-factor', {
      method: 'DELETE',
      body: JSON.stringify({ password, code }),
    }),
  /** Take the second factor off the account of an address, for a holder who lost it. */
  removeAccountSecondFactor: (email: string) =>
    adminFetch<void>('/accounts/second-factor', {
      method: 'DELETE',
      body: JSON.stringify({ email }),
    }),
  /** Who may use the operator's AI provider, and how many accounts are approved for it. */
  operatorAi: () => adminFetch<AdminOperatorAi>('/accounts/operator-ai'),
  /** Approve the account of an address for the operator's AI provider. */
  approveOperatorAi: (email: string) =>
    adminFetch<void>('/accounts/operator-ai', { method: 'PUT', body: JSON.stringify({ email }) }),
  /** Take the approval of the account of an address back. */
  revokeOperatorAi: (email: string) =>
    adminFetch<void>('/accounts/operator-ai', {
      method: 'DELETE',
      body: JSON.stringify({ email }),
    }),
  signOut: () => adminFetch<void>('/session', { method: 'DELETE' }),
  /** End every admin session there is, this one too. */
  endAllSessions: () => adminFetch<void>('/session/end-all', { method: 'POST' }),
  stats: () => adminFetch<AdminStats>('/stats'),
  startDbUpdate: () => adminFetch<DbUpdateState>('/db/update', { method: 'POST' }),
  dbUpdateStatus: () => adminFetch<DbUpdateState>('/db/update/status'),
  startUsdaImport: (dataTypes?: string) =>
    adminFetch<UsdaImportRunnerState>(
      `/db/import-usda${dataTypes ? `?dataTypes=${encodeURIComponent(dataTypes)}` : ''}`,
      { method: 'POST' },
    ),
  usdaImportStatus: () => adminFetch<UsdaImportRunnerState>('/db/import-usda/status'),

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
  listIngredientNameDrafts: (
    params: {
      status?: string;
      batchId?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) => {
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
  approveIngredientNameDraft: (id: string, locale: string, reviewedByLabel: string) =>
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
  /** Reject up to a hundred drafts of names with one reason; answers which were rejected and which were left as they were. */
  rejectIngredientNameDrafts: (ids: string[], reviewedByLabel: string, reason?: string) =>
    adminFetch<{ rejected: string[]; skipped: { id: string; error: string }[] }>(
      '/drafts/ingredient-names/reject',
      {
        method: 'POST',
        body: JSON.stringify({ ids, reviewedByLabel, ...(reason ? { reason } : {}) }),
      },
    ),
  deleteIngredientNameDraft: (id: string) =>
    adminFetch<void>(`/drafts/ingredient-names/${id}`, { method: 'DELETE' }),

  // Drafts: recipes from elsewhere
  importRecipes: (request: RecipeImportRequestInput) =>
    adminFetch<RecipeImportResult>('/drafts/recipes/import', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  importRejections: () => adminFetch<StoredImportRejection[]>('/drafts/recipes/import/rejections'),
  clearImportRejections: () =>
    adminFetch<void>('/drafts/recipes/import/rejections', { method: 'DELETE' }),

  // Drafts: a language recipes lack
  startTranslations: (spec: { locale: string; limit: number }) =>
    adminFetch<DraftRunnerState>('/drafts/translations/generate', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),
  translationsStatus: () => adminFetch<DraftRunnerState>('/drafts/translations/generate/status'),
  stopTranslations: () =>
    adminFetch<DraftRunnerState>('/drafts/translations/generate/stop', { method: 'POST' }),

  // Drafts: recipes
  startRecipeGenerator: (spec: RecipeGenerateSpec) =>
    adminFetch<RecipeRunnerState>('/drafts/recipes/generate', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),
  recipeGeneratorStatus: () => adminFetch<RecipeRunnerState>('/drafts/recipes/generate/status'),
  stopRecipeGenerator: () =>
    adminFetch<RecipeRunnerState>('/drafts/recipes/generate/stop', { method: 'POST' }),
  listRecipeDrafts: (
    params: {
      status?: string;
      batchId?: string;
      complexity?: string;
      /** Where the drafts came from: `AI_USER` are the ones users sent. */
      source?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.batchId) q.set('batchId', params.batchId);
    if (params.complexity) q.set('complexity', params.complexity);
    if (params.source) q.set('source', params.source);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    const qs = q.toString();
    return adminFetch<PagedDrafts<RecipeDraft>>(`/drafts/recipes${qs ? `?${qs}` : ''}`);
  },
  getRecipeDraft: (id: string) => adminFetch<RecipeDraft>(`/drafts/recipes/${id}`),
  patchRecipeDraft: (id: string, patch: RecipeDraftPatch, dryRun = false) =>
    adminFetch<RecipeDraft>(`/drafts/recipes/${id}${dryRun ? '?dryRun=true' : ''}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  approveRecipeDraft: (id: string, locale: string, reviewedByLabel: string) =>
    adminFetch<RecipeDraft>(`/drafts/recipes/${id}/approve?locale=${encodeURIComponent(locale)}`, {
      method: 'POST',
      body: JSON.stringify({ reviewedByLabel }),
    }),
  rejectRecipeDraft: (id: string, locale: string, reviewedByLabel: string, reason?: string) =>
    adminFetch<RecipeDraft>(`/drafts/recipes/${id}/reject?locale=${encodeURIComponent(locale)}`, {
      method: 'POST',
      body: JSON.stringify({ reviewedByLabel, reason }),
    }),
  deleteRecipeDraft: (id: string) =>
    adminFetch<void>(`/drafts/recipes/${id}`, { method: 'DELETE' }),
  /** Reject up to a hundred recipe drafts with one reason; answers which were rejected and which were left as they were. */
  rejectRecipeDrafts: (ids: string[], reviewedByLabel: string, reason?: string) =>
    adminFetch<{ rejected: string[]; skipped: { id: string; error: string }[] }>(
      '/drafts/recipes/reject',
      {
        method: 'POST',
        body: JSON.stringify({ ids, reviewedByLabel, ...(reason ? { reason } : {}) }),
      },
    ),
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

  // Current-state export/push — the full ingredient-override set rebuilt from
  // the DB, available regardless of draft status (unlike the ship modes).
  downloadCurrentOverrides: async (): Promise<void> => {
    const blob = await admin.download('/drafts/ship/current-overrides');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ingredient-overrides.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  restoreInstanceData: () =>
    adminFetch<RestoreResponse>('/drafts/ship/restore', { method: 'POST' }),

  // What the API sees of the connection this request arrived on.
  connection: () => adminFetch<AdminConnection>('/connection'),

  // Instance settings — reviewer-interface toggle + password.
  instanceSettings: () => adminFetch<InstanceSettingsDto>('/instance-settings'),
  patchInstanceSettings: (body: InstanceSettingsPatchPayload) =>
    adminFetch<InstanceSettingsDto>('/instance-settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};

export interface InstanceSettingsPatchPayload {
  reviewerEnabled?: boolean;
  /** Empty string clears the existing hash; `undefined` means "no change". */
  reviewerPassword?: string;
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

/** Save `content` as a JSON file under `name`. It is made in the page: no server is asked for it. */
export function saveJsonFile(name: string, content: unknown): void {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(content, null, 2)}\n`], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
