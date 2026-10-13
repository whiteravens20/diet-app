// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Admin API client for `/api/admin/*`: an identity of its own, apart from the
 * accounts `lib/api.ts` speaks for. The administrator signs in once, and the
 * session is a cookie the API set, which no script reads: the page holds no
 * credentials, and nothing here keeps a password.
 */
import type { AdminSessionState, Cuisine, DietType, DraftRunNote, MealType, RecipeImportResult, SecondFactorSetup, StoredImportRejection } from '@diet-app/shared';
import { apiClient } from './http';

// A version before this one kept the administrator's user and password in
// sessionStorage for the life of the tab. Whatever it left there is removed.
if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('diet-app.admin-basic');

// The session is the cookie, which the browser sends: nothing is added to a request.
const admin = apiClient('/admin');
const adminFetch = admin.request;

export interface AdminStatus {
  enabled: boolean;
  message: string | null;
}

/** How a request reached the API: see the admin controller's connection check. */
export interface AdminConnection {
  clientAddress: string | null;
  peerAddress: string | null;
  forwardedFor: string | null;
  /** How many addresses the forwarding header holds: one for every proxy that wrote into it. */
  forwardedHops: number;
  trustProxy: false | number | string[];
  countedAsProxy: boolean;
  /** `TRUST_PROXY` counts more proxies than wrote into the header: a visitor can claim any address. */
  overTrusted: boolean;
}

/** Shares of a day's energy, adding up to one. */
export interface MacroShares {
  protein: number;
  fat: number;
  carbs: number;
}

export interface AdminStats {
  counts: { ingredients: number; recipes: number; substitutions: number };
  /** How many recipes each diet has for each meal. */
  coverage: Record<DietType, Record<MealType, number>>;
  /** How many a release needs for each. */
  coverageTarget: number;
  /** How many recipe drafts wait in the queue for each: a recipe run that fills the catalogue counts them with the recipes. */
  coverageWaiting: Record<DietType, Record<MealType, number>>;
  /**
   * For each diet, what its plans aim at and what they reach with the recipes
   * there are, as shares of a day's energy; `reached` is null where no plan
   * can be made. A diet whose `distance` is over `outOfReach` needs recipes
   * that fit it. `packsUsed` is the share those plans use of what they buy
   * in packs that do not keep once opened; null where they buy none.
   */
  macros: {
    outOfReach: number;
    diets: Record<DietType, { target: MacroShares; reached: (MacroShares & { distance: number; packsUsed: number | null }) | null }>;
  };
  seed: {
    lastSeededAt: string | null;
    storedHash: string | null;
    currentHash: string;
    updateAvailable: boolean;
    files: { name: string; present: boolean; bytes: number }[];
  };
}

interface DbUpdateResult {
  deletedRecipes: number;
  deletedIngredients: number;
  /** Dropped from the data but still used by someone: kept, hidden from search and planning. */
  retiredRecipes: number;
  retiredIngredients: number;
  counts: { ingredients: number; recipes: number; substitutions: number };
  hash: string;
  seededAt: string;
}

type DbUpdateStatus = 'idle' | 'running' | 'done' | 'error';

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

type UsdaImportStatus = 'idle' | 'running' | 'done' | 'error';

export interface UsdaImportRunnerState {
  status: UsdaImportStatus;
  startedAt: string | null;
  finishedAt: string | null;
  page: number | null;
  totalPages: number | null;
  kept: number;
  skipped: number;
  excluded: number;
  /** Foods left out because their record is incomplete or contradicts itself. */
  refused: number;
  dataTypes: string | null;
  demoKey: boolean;
  result: {
    kept: number;
    skipped: number;
    excluded: number;
    refused: number;
    /** The first hundred of them, with the reason. */
    refusals: { name: string; reason: string }[];
    totalPages: number;
    outFile: string;
    dataTypes: string;
    demoKey: boolean;
  } | null;
  /** What went wrong, in the API's words: detail under the explanation. */
  error: string | null;
  /** Why a run failed; `failed` is anything nobody foresaw. */
  errorReason: 'over_limit' | 'key_refused' | 'unavailable' | 'not_writable' | 'failed' | null;
  /** How long the source asks to wait before the next try, in seconds, when it said so. */
  retryAfterSeconds: number | null;
}

// ── Curation queue (drafts) ───────────────────────────────────────────────────

export interface DraftLocaleReview {
  locale: string;
  action: 'APPROVE' | 'REJECT';
  /** Who wrote it; null on a review from before the role was recorded. */
  byRole: 'ADMIN' | 'REVIEWER' | null;
  reviewedByLabel: string;
  reason: string | null;
  reviewedAt: string;
}

/** A review that a later review of the same language, or an edit of the draft, took the place of. */
export interface DraftPastReview extends DraftLocaleReview {
  supersededAt: string;
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
  source: 'AI' | 'EXTERNAL' | 'AI_USER';
  batchId: string;
  modelUsed: string | null;
  generatorPrompt: string | null;
  shippedPRUrl: string | null;
  shippedAt: string | null;
  createdAt: string;
  updatedAt: string;
  localeReviews: DraftLocaleReview[];
  pastReviews: DraftPastReview[];
}

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
  /** In the run's scope, and left out because there was nothing to do for them. */
  skipped: number;
  /** Why the run had nothing to do or ended early, when that is no failure. */
  note: DraftRunNote | null;
  configured: boolean;
}

export interface IngredientNameGenerateSpec {
  scope: 'all-usda-missing' | 'specific-slugs';
  slugs?: string[];
  targetLocales?: string[];
}

// ── Recipe drafts ─────────────────────────────────────────────────────────────

type RecipeComplexity = 'simple' | 'medium' | 'complex';

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
  /** The cuisine the recipe ships with, if any. */
  cuisine: Cuisine | null;
  complexity: RecipeComplexity;
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  allergens: string[];
  ingredients: RecipeDraftIngredientLine[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';
  source: 'AI' | 'EXTERNAL' | 'AI_USER';
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
  pastReviews: DraftPastReview[];
}

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

export interface RecipeRunnerState extends DraftRunnerState {
  /** The diet and the meal the run is writing for, when it chooses them itself. */
  target: { diet: DietType; meal: MealType } | null;
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
  status: () => adminFetch<AdminStatus>('/status'),
  /** Whether there is a panel, and whether this browser is signed in to it. */
  session: () => adminFetch<AdminSessionState>('/session'),
  /** Give the instance's user and password once, for the session, with a code where the administrator has a second factor. */
  signIn: (user: string, password: string, code?: string) => adminFetch<void>('/session', { method: 'POST', body: JSON.stringify({ user, password, ...(code ? { code } : {}) }) }),
  /** A secret to set an authenticator app up with, for the password. */
  proposeSecondFactor: (password: string) => adminFetch<SecondFactorSetup>('/session/second-factor/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  /** The first code from the app: signing in takes one from now on. */
  beginSecondFactor: (enrolment: string, code: string) => adminFetch<void>('/session/second-factor', { method: 'POST', body: JSON.stringify({ enrolment, code }) }),
  endSecondFactor: (password: string, code: string) => adminFetch<void>('/session/second-factor', { method: 'DELETE', body: JSON.stringify({ password, code }) }),
  /** Take the second factor off the account of an address, for a holder who lost it. */
  removeAccountSecondFactor: (email: string) => adminFetch<void>('/accounts/second-factor', { method: 'DELETE', body: JSON.stringify({ email }) }),
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

  // Drafts: recipes from elsewhere
  importRecipes: (request: RecipeImportRequestInput) => adminFetch<RecipeImportResult>('/drafts/recipes/import', { method: 'POST', body: JSON.stringify(request) }),
  importRejections: () => adminFetch<StoredImportRejection[]>('/drafts/recipes/import/rejections'),
  clearImportRejections: () => adminFetch<void>('/drafts/recipes/import/rejections', { method: 'DELETE' }),

  // Drafts: a language recipes lack
  startTranslations: (spec: { locale: string; limit: number }) =>
    adminFetch<DraftRunnerState>('/drafts/translations/generate', { method: 'POST', body: JSON.stringify(spec) }),
  translationsStatus: () => adminFetch<DraftRunnerState>('/drafts/translations/generate/status'),
  stopTranslations: () => adminFetch<DraftRunnerState>('/drafts/translations/generate/stop', { method: 'POST' }),

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
    /** Where the drafts came from: `AI_USER` are the ones users sent. */
    source?: string;
    page?: number;
    pageSize?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.batchId) q.set('batchId', params.batchId);
    if (params.complexity) q.set('complexity', params.complexity);
    if (params.source) q.set('source', params.source);
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
  /** Reject up to a hundred recipe drafts with one reason; answers which were rejected and which were left as they were. */
  rejectRecipeDrafts: (ids: string[], reviewedByLabel: string, reason?: string) =>
    adminFetch<{ rejected: string[]; skipped: { id: string; error: string }[] }>('/drafts/recipes/reject', {
      method: 'POST',
      body: JSON.stringify({ ids, reviewedByLabel, ...(reason ? { reason } : {}) }),
    }),
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
  pushCurrentOverrides: () =>
    adminFetch<CurrentOverridesPushResponse>('/drafts/ship/current-overrides/push', {
      method: 'POST',
    }),
  pullCurrentOverrides: (source?: string) =>
    adminFetch<CurrentOverridesPullResponse>('/drafts/ship/current-overrides/pull', {
      method: 'POST',
      body: JSON.stringify(source ? { source } : {}),
    }),
  restoreInstanceData: () => adminFetch<RestoreResponse>('/drafts/ship/restore', { method: 'POST' }),

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
    bundle: { available: true };
  };
  pull: { available: true; defaultSource: string; tokenSet: boolean };
  instanceData: InstanceDataState;
  approvedCounts: { recipe: number; ingredientName: number };
}

/** The instance's own data directory: what local ships copied there, and whether the API can still write to it. */
export interface InstanceDataState {
  writable: boolean;
  recipeFiles: number;
  recipes: number;
  names: number;
}

/** What a restore from the instance's data directory did. Reasons read as a skipped draft's do. */
export interface RestoreResponse {
  recipes: { added: number; rewritten: number; skipped: { file: string; slug: string; reason: string }[] };
  names: { applied: number; skippedSlugs: string[]; refused: { slug: string; reason: string }[] };
  unreadable: { file: string; reason: string }[];
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

export interface CurrentOverridesPushResponse {
  prUrl: string;
  branch: string;
  rowCount: number;
}

export interface CurrentOverridesPullResponse {
  source: string;
  resolvedUrl: string;
  applied: number;
  rowsWritten: number;
  skippedSlugs: string[];
  /** Entries that break a rule for names, with the reason as a skipped draft carries one. */
  refused: { slug: string; reason: string }[];
  total: number;
}

/** An approved draft that did not ship: its slug (or its ingredient's), and why, as `<rule>` or `<rule>: <detail>`. */
export interface ShipSkipped {
  draftId: string;
  slug: string;
  reason: string;
}

export type ShipResponse =
  | {
      mode: 'local';
      kind: ShipKind;
      shippedDraftIds: string[];
      skipped: ShipSkipped[];
      sidecarPaths: string[];
      sidecarError?: string;
    }
  | {
      mode: 'upstream-pr';
      prUrl: string;
      branch: string;
      shippedDraftIds: string[];
      skipped: ShipSkipped[];
    }
  | {
      mode: 'bundle';
      kind: ShipKind;
      batchId: string;
      draftIds: string[];
      /** Approved drafts the bundle leaves out, with the reason. */
      skipped: ShipSkipped[];
      /** The name to save the file under, and what it holds: the shape the data directory takes. */
      fileName: string;
      content: unknown;
    };

/** Save `content` as a JSON file under `name`. It is made in the page: no server is asked for it. */
export function saveJsonFile(name: string, content: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(content, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
