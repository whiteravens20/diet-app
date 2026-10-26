// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeOfflineLeftovers } from './offline-leftovers';

/** The browser's cache storage, as far as the removal uses it, holding stores by these names: the DOM the tests run in has none. */
function aCacheStorage(names: string[]) {
  const held = new Set(names);
  return {
    keys: async () => [...held],
    delete: async (name: string) => held.delete(name),
  };
}

/** A registration of a service worker at this address, by the path its script was fetched from and how far the worker got. */
const aRegistration = (script: string, stage: 'active' | 'waiting' | 'installing' = 'active') => ({
  active: null,
  waiting: null,
  installing: null,
  [stage]: { scriptURL: new URL(script, window.location.origin).href },
  unregister: vi.fn(async () => true),
});

const ACCOUNT = '22222222-2222-4222-8222-222222222222';

describe('what the versions that could be read without a network left in a browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is removed: their worker, what they kept in the cache storage and what they wrote into the local storage', async () => {
    const stores = aCacheStorage([
      'diet-app.pages.v1',
      'diet-app.files.v1',
      `diet-app.offline.${ACCOUNT}`,
      'another-application',
    ]);
    vi.stubGlobal('caches', stores);
    const theirs = aRegistration('/sw.js');
    const another = aRegistration('/elsewhere/worker.js');
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: async () => [theirs, another] },
    });
    localStorage.setItem('diet-app.offline.account', ACCOUNT);
    localStorage.setItem(
      'diet-app.offline.waiting',
      JSON.stringify([{ listId: 'list', itemId: 'rice', checked: true }]),
    );
    localStorage.setItem('another-application', 'kept');

    await removeOfflineLeftovers();

    expect(await stores.keys()).toEqual(['another-application']);
    expect(theirs.unregister).toHaveBeenCalledTimes(1);
    expect(another.unregister).not.toHaveBeenCalled();
    expect(localStorage.getItem('diet-app.offline.account')).toBeNull();
    expect(localStorage.getItem('diet-app.offline.waiting')).toBeNull();
    expect(localStorage.getItem('another-application')).toBe('kept');
  });

  it('is removed where it can be, when the browser refuses the page its workers', async () => {
    const stores = aCacheStorage([`diet-app.offline.${ACCOUNT}`]);
    vi.stubGlobal('caches', stores);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: () => Promise.reject(new DOMException('Not allowed', 'SecurityError')),
      },
    });
    localStorage.setItem('diet-app.offline.account', ACCOUNT);

    await removeOfflineLeftovers();

    expect(await stores.keys()).toEqual([]);
    expect(localStorage.getItem('diet-app.offline.account')).toBeNull();
  });

  it('takes away their worker however far it got, and a registration with none left alone', async () => {
    const waiting = aRegistration('/sw.js', 'waiting');
    const installing = aRegistration('/sw.js', 'installing');
    const empty = { active: null, waiting: null, installing: null, unregister: vi.fn() };
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: async () => [waiting, installing, empty] },
    });

    await removeOfflineLeftovers();

    expect(waiting.unregister).toHaveBeenCalledTimes(1);
    expect(installing.unregister).toHaveBeenCalledTimes(1);
    expect(empty.unregister).not.toHaveBeenCalled();
  });

  it('is removed where it can be, when the browser refuses the page its local storage', async () => {
    const stores = aCacheStorage([`diet-app.offline.${ACCOUNT}`]);
    vi.stubGlobal('caches', stores);
    vi.stubGlobal('localStorage', {
      removeItem: () => {
        throw new DOMException('Not allowed', 'SecurityError');
      },
    });

    await removeOfflineLeftovers();

    expect(await stores.keys()).toEqual([]);
  });

  it('is removed where it can be, when the browser refuses the page its cache storage', async () => {
    vi.stubGlobal('caches', {
      keys: () => Promise.reject(new DOMException('Not allowed', 'SecurityError')),
    });
    localStorage.setItem('diet-app.offline.waiting', '[]');

    await expect(removeOfflineLeftovers()).resolves.toBeUndefined();
    expect(localStorage.getItem('diet-app.offline.waiting')).toBeNull();
  });

  it('is nothing to a browser that gives the page no worker and no cache storage', async () => {
    expect('serviceWorker' in navigator).toBe(false);
    expect(typeof caches).toBe('undefined');

    await expect(removeOfflineLeftovers()).resolves.toBeUndefined();
  });
});
