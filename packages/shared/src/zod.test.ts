// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from 'zod';

/** The library is loaded once for all the tests, and keeps its settings: each test begins with them as a new process has them. */
const asAtTheStart = (): void => {
  delete (config() as { jitless?: boolean }).jitless;
};

/** The contract as a process that was just started loads it, and what it then asked the JavaScript engine to compile. */
async function loaded(inABrowser: boolean) {
  vi.resetModules();
  asAtTheStart();
  if (inABrowser) vi.stubGlobal('document', {});
  const compiled = vi.fn();
  vi.stubGlobal(
    'Function',
    new Proxy(Function, {
      construct: (target, args: unknown[]) => {
        compiled(args);
        return Reflect.construct(target, args) as object;
      },
      apply: (target, self, args: unknown[]) => {
        compiled(args);
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  const contract = await import('./index.js');
  const parsed = contract.LoginRequest.safeParse({
    email: 'holder@example.test',
    password: 'a-password',
  });
  return {
    jitless: config().jitless === true,
    compiled: compiled.mock.calls.length,
    parsed: parsed.success,
  };
}

describe('how the contract checks its input', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    asAtTheStart();
  });

  it("makes no code at run time in a browser, where the page's content security policy forbids it, and checks all the same", async () => {
    const browser = await loaded(true);

    expect(browser.jitless).toBe(true);
    expect(browser.compiled).toBe(0);
    expect(browser.parsed).toBe(true);
  });

  it('lets the library compile its checks on a server', async () => {
    const server = await loaded(false);

    expect(server.jitless).toBe(false);
    expect(server.compiled).toBeGreaterThan(0);
    expect(server.parsed).toBe(true);
  });
});
