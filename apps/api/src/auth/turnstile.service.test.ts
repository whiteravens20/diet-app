// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for TurnstileService. `fetch` is stubbed. Focus: the no-op pass
 * when disabled (self-host default), fail-closed when enabled-but-misconfigured,
 * and the success/failure mapping of Cloudflare's siteverify response.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

function makeService(values: Record<string, unknown>) {
  const config = { get: (k: string) => values[k] };
  // Imported lazily so the module sees the stubbed global fetch per test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return import('./turnstile.service.js').then((m) => new m.TurnstileService(config as any));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TurnstileService.verify', () => {
  it('passes unconditionally when disabled (no token needed)', async () => {
    const svc = await makeService({ TURNSTILE_ENABLED: false });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await svc.verify(undefined)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when enabled but no token supplied', async () => {
    const svc = await makeService({ TURNSTILE_ENABLED: true, TURNSTILE_SECRET_KEY: 'secret' });
    expect(await svc.verify(undefined)).toBe(false);
  });

  it('fails closed when enabled but the secret key is missing', async () => {
    const svc = await makeService({ TURNSTILE_ENABLED: true, TURNSTILE_SECRET_KEY: undefined });
    expect(await svc.verify('tok')).toBe(false);
  });

  it('returns true on a successful siteverify response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const svc = await makeService({ TURNSTILE_ENABLED: true, TURNSTILE_SECRET_KEY: 'secret' });
    expect(await svc.verify('tok')).toBe(true);
  });

  it('returns false on an unsuccessful siteverify response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 200 }),
    );
    const svc = await makeService({ TURNSTILE_ENABLED: true, TURNSTILE_SECRET_KEY: 'secret' });
    expect(await svc.verify('tok')).toBe(false);
  });

  it('fails closed (false) when the network call throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const svc = await makeService({ TURNSTILE_ENABLED: true, TURNSTILE_SECRET_KEY: 'secret' });
    expect(await svc.verify('tok')).toBe(false);
  });
});
