// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The browser's cache storage, as far as the application uses it, for tests:
 * the DOM the tests run in has none. Answers are kept by the address they
 * were put under, in the order they were put.
 */
class ACache {
  private readonly kept = new Map<string, Response>();

  private static addressOf(request: RequestInfo | URL): string {
    return typeof request === 'string' ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.kept.set(ACache.addressOf(request), response.clone());
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.kept.get(ACache.addressOf(request))?.clone();
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.kept.delete(ACache.addressOf(request));
  }

  async keys(): Promise<string[]> {
    return [...this.kept.keys()];
  }
}

/** A cache storage with nothing in it. `names()` says which stores it holds, for a test to look at. */
export function aCacheStorage(): CacheStorage & { names(): string[]; held(name: string): Promise<string[]> } {
  const stores = new Map<string, ACache>();
  return {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new ACache());
      return stores.get(name) as unknown as Cache;
    },
    async has(name: string) {
      return stores.has(name);
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async match() {
      return undefined;
    },
    names: () => [...stores.keys()],
    held: async (name: string) => (await stores.get(name)?.keys()) ?? [],
  };
}
