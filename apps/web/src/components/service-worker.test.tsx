// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEPT_AHEAD, ServiceWorker } from './service-worker';

/** A browser that takes service workers, signed in or not. */
function aBrowser(signedIn: boolean) {
  document.cookie = signedIn ? 'diet_session=1; Path=/' : 'diet_session=; Max-Age=0; Path=/';
  const postMessage = vi.fn();
  const register = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, serviceWorker: { register, ready: Promise.resolve({ active: { postMessage } }) } });
  return { register, postMessage };
}

describe('handing the browser the service worker', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    document.cookie = 'diet_session=; Max-Age=0; Path=/';
  });

  it('is done by a build that is served, and tells the worker which pages of an account to keep ahead', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { register, postMessage } = aBrowser(true);

    render(<ServiceWorker />);

    expect(register).toHaveBeenCalledWith('/sw.js');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'keep-pages', pages: KEPT_AHEAD }));
    expect(KEPT_AHEAD).toContain('/shopping-lists');
  });

  it('keeps no page of an account ahead for a browser nobody is signed in in', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { register, postMessage } = aBrowser(false);

    render(<ServiceWorker />);
    await Promise.resolve();

    expect(register).toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('is not done while the application is being developed', () => {
    const { register, postMessage } = aBrowser(true);

    render(<ServiceWorker />);

    expect(register).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('is left out, without failing, by a browser that gives the page no worker', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal('navigator', { userAgent: 'a browser over plain http' });

    expect(() => render(<ServiceWorker />)).not.toThrow();
  });
});
