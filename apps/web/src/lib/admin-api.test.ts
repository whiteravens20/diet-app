// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveJsonFile } from './admin-api';

describe('saving a file the page already holds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hands the browser the content as JSON under the name given, and asks no server', async () => {
    const made: Blob[] = [];
    const clicked: { name: string; href: string }[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => (made.push(blob), 'blob:a-file'), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.href });
    });
    const asked = vi.spyOn(globalThis, 'fetch');

    saveJsonFile('bundle-2026-10-11.json', [{ slug: 'oat-bowl', title: { pl: 'Owsianka' } }]);

    expect(clicked).toEqual([{ name: 'bundle-2026-10-11.json', href: 'blob:a-file' }]);
    expect(made[0]!.type).toBe('application/json');
    expect(JSON.parse(await made[0]!.text())).toEqual([{ slug: 'oat-bowl', title: { pl: 'Owsianka' } }]);
    expect(await made[0]!.text()).toContain('\n  {');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a-file');
    // The link does not stay in the page.
    expect(document.querySelector('a[download]')).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('the administrator\'s requests', () => {
  const answered = (status: number, body?: unknown): Response =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  /** The client as a page that was just loaded has it. */
  async function aPage() {
    vi.resetModules();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { adminApi, AdminApiError } = await import('./admin-api');
    return { adminApi, AdminApiError, fetchMock };
  }

  it('give the user and the password once, at sign-in, and keep neither', async () => {
    const { adminApi, fetchMock } = await aPage();
    fetchMock.mockResolvedValue(answered(204));

    await adminApi.signIn('admin', 'a-long-admin-password');

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/admin/session');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ user: 'admin', password: 'a-long-admin-password' }) });
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('a-long-admin-password');
    expect(JSON.stringify({ ...localStorage })).not.toContain('a-long-admin-password');
  });

  it('carry the session as a cookie and no password: nothing is added to a request', async () => {
    const { adminApi, fetchMock } = await aPage();
    fetchMock.mockImplementation(() => Promise.resolve(answered(200, { counts: {} })));

    await adminApi.stats();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(init.credentials).toBe('same-origin');
  });

  it('remove the user and password an earlier version kept for the life of the tab', async () => {
    sessionStorage.setItem('diet-app.admin-basic', btoa('admin:a-long-admin-password'));

    await aPage();

    expect(sessionStorage.getItem('diet-app.admin-basic')).toBeNull();
  });

  it('say when the session has ended, by its code', async () => {
    const { adminApi, AdminApiError, fetchMock } = await aPage();
    fetchMock.mockResolvedValue(answered(401, { error: 'INVALID_ADMIN_SESSION', message: 'The admin session is invalid or has ended.' }));

    const refused = await adminApi.stats().catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(AdminApiError);
    expect(refused).toMatchObject({ status: 401, code: 'INVALID_ADMIN_SESSION' });
  });

  it('ask whether this browser is signed in, and end the session here or everywhere', async () => {
    const { adminApi, fetchMock } = await aPage();
    fetchMock.mockResolvedValueOnce(answered(200, { enabled: true, signedIn: false })).mockImplementation(() => Promise.resolve(answered(204)));

    expect(await adminApi.session()).toEqual({ enabled: true, signedIn: false });
    await adminApi.signOut();
    await adminApi.endAllSessions();

    expect(fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method ?? 'GET'} ${url as string}`)).toEqual([
      'GET /api/admin/session',
      'DELETE /api/admin/session',
      'POST /api/admin/session/end-all',
    ]);
  });
});

