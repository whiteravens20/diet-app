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

export const adminApi = {
  status: () => adminFetch<AdminStatus>('/status', {}, false),
  stats: () => adminFetch<AdminStats>('/stats'),
  updateDb: () => adminFetch<DbUpdateResult>('/db/update', { method: 'POST' }),
};
