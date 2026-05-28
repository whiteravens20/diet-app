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

/** Per-source counts inside a single parent partition. */
export interface SourceBreakdown {
  curated_json: number;
  ai: number;
  manual: number;
  missing: number;
}

/** One row per non-canonical locale from `GET /api/admin/translations/status`. */
export interface TranslationStatusEntry {
  locale: string;
  curated: { ingredients: SourceBreakdown; recipes: SourceBreakdown };
  imported: { ingredients: SourceBreakdown };
  missingSamples: {
    curatedIngredients: string[];
    curatedRecipes: string[];
    importedIngredients: string[];
  };
}

export type TranslateScope = 'missing' | 'ai' | 'all';
export type TranslateStatus = 'idle' | 'running' | 'done' | 'error';

export interface TranslateRunnerState {
  status: TranslateStatus;
  startedAt: string | null;
  finishedAt: string | null;
  localesQueued: string[];
  localesDone: string[];
  currentLocale: string | null;
  processed: number;
  total: number;
  failed: number;
  totals: { processed: number; failed: number; written: number };
  provider: string | null;
  model: string | null;
  error: string | null;
  configured?: boolean;
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

export const adminApi = {
  status: () => adminFetch<AdminStatus>('/status', {}, false),
  stats: () => adminFetch<AdminStats>('/stats'),
  startDbUpdate: () => adminFetch<DbUpdateState>('/db/update', { method: 'POST' }),
  dbUpdateStatus: () => adminFetch<DbUpdateState>('/db/update/status'),
  translationsStatus: () =>
    adminFetch<TranslationStatusEntry[]>('/translations/status'),
  startTranslate: (locale: 'all' | string, scope: TranslateScope = 'missing') =>
    adminFetch<TranslateRunnerState>(
      `/translations/fill?locale=${encodeURIComponent(locale)}&scope=${scope}`,
      { method: 'POST' },
    ),
  translateStatus: () =>
    adminFetch<TranslateRunnerState>('/translations/fill/status'),
  stopTranslate: () =>
    adminFetch<TranslateRunnerState>('/translations/fill/stop', { method: 'POST' }),
  wipeAiTranslations: () =>
    adminFetch<{ ingredients: number; recipes: number }>('/translations/wipe-ai', {
      method: 'POST',
    }),
  startUsdaImport: (dataTypes?: string) =>
    adminFetch<UsdaImportRunnerState>(
      `/db/import-usda${dataTypes ? `?dataTypes=${encodeURIComponent(dataTypes)}` : ''}`,
      { method: 'POST' },
    ),
  usdaImportStatus: () =>
    adminFetch<UsdaImportRunnerState>('/db/import-usda/status'),
};
