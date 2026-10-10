// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for AiKeyService. Prisma + config are mocked. Focus: BYOK key
 * encryption (write-only — `hasKey`, never the plaintext), the SSRF write-time
 * guard on Ollama baseUrl (OLLAMA_USER_POLICY), ownership checks on remove, the
 * "last config flips back to admin" safety net, and the failover chain per
 * aiMode.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiKeyService } from './ai-key.service.js';
import { encrypt } from '../common/crypto.js';
import { openKey, sealKey } from './key-cipher.js';

const ENC_KEY = 'b'.repeat(64);

function makeConfig(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    AI_KEY_ENCRYPTION_SECRET: ENC_KEY,
    OLLAMA_USER_POLICY: 'allowlist',
    OLLAMA_BASE_URL: 'http://ollama:11434',
    OLLAMA_ALLOWED_HOSTS: undefined,
    AI_DEFAULT_PROVIDER: undefined,
    AI_DEFAULT_MODEL: undefined,
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
  };
  const values = { ...base, ...overrides };
  return { get: (k: string) => values[k] };
}

const withoutUndefined = (data: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    aiProviderConfig: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      // As the database answers: a column that was not written is null.
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'cfg-1', isAdminDefault: false, encryptedKey: null, ...withoutUndefined(args.data) }),
      ),
      update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'cfg-1', isAdminDefault: false, encryptedKey: null, ...withoutUndefined(args.data) }),
      ),
      delete: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => {
      // single-arg callback form
      return cb({
        aiProviderConfig: {
          delete: vi.fn().mockResolvedValue({}),
          count: vi.fn().mockResolvedValue(0),
        },
        user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      });
    }),
    ...overrides,
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>, config = makeConfig()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test doubles
  return new AiKeyService(prisma as any, config as any);
}

describe('AiKeyService.upsert', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('encrypts the API key and never returns the plaintext (hasKey only)', async () => {
    const service = makeService(prisma);
    const dto = await service.upsert('user-1', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-secret-123',
      priority: 0,
      enabled: true,
    } as never);

    expect(dto).not.toHaveProperty('apiKey');
    expect(dto).not.toHaveProperty('encryptedKey');
    expect(dto.hasKey).toBe(true);

    const created = prisma.aiProviderConfig.create.mock.calls[0][0].data;
    expect(created.encryptedKey).toBeTypeOf('string');
    expect(created.encryptedKey).not.toContain('sk-secret-123');
    // Round-trips back to the original under the configured key.
    expect(openKey(created.encryptedKey as string, ENC_KEY)).toEqual({ ok: true, key: 'sk-secret-123' });
    expect(dto.keyUnreadable).toBe(false);
  });

  it('persists an allowlisted Ollama baseUrl (operator default host)', async () => {
    const service = makeService(prisma);
    await service.upsert('user-1', {
      provider: 'ollama',
      model: 'llama3.1:8b',
      baseUrl: 'http://ollama:11434',
      priority: 0,
      enabled: true,
    } as never);
    expect(prisma.aiProviderConfig.create).toHaveBeenCalled();
    expect(prisma.aiProviderConfig.create.mock.calls[0][0].data.baseUrl).toBe('http://ollama:11434');
  });

  it('rejects an internal Ollama baseUrl under the default allowlist policy (SSRF)', async () => {
    const service = makeService(prisma);
    await expect(
      service.upsert('user-1', {
        provider: 'ollama',
        model: 'llama3.1:8b',
        baseUrl: 'http://169.254.169.254/latest/meta-data',
        priority: 0,
        enabled: true,
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'OLLAMA_HOST_NOT_ALLOWED' }),
    });
    expect(prisma.aiProviderConfig.create).not.toHaveBeenCalled();
  });

  it('rejects any user Ollama baseUrl when policy is off', async () => {
    const service = makeService(prisma, makeConfig({ OLLAMA_USER_POLICY: 'off' }));
    await expect(
      service.upsert('user-1', {
        provider: 'ollama',
        model: 'llama3.1:8b',
        baseUrl: 'https://my-box.example.com:11434',
        priority: 0,
        enabled: true,
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'OLLAMA_USER_DISABLED' }),
    });
  });

  it('allows any public Ollama host when policy is public', async () => {
    const service = makeService(prisma, makeConfig({ OLLAMA_USER_POLICY: 'public' }));
    await service.upsert('user-1', {
      provider: 'ollama',
      model: 'llama3.1:8b',
      baseUrl: 'https://ollama.my-domain.example:11434',
      priority: 0,
      enabled: true,
    } as never);
    expect(prisma.aiProviderConfig.create).toHaveBeenCalled();
  });

  it('still blocks internal hosts even when policy is public', async () => {
    const service = makeService(prisma, makeConfig({ OLLAMA_USER_POLICY: 'public' }));
    await expect(
      service.upsert('user-1', {
        provider: 'ollama',
        model: 'llama3.1:8b',
        baseUrl: 'http://10.0.0.5:11434',
        priority: 0,
        enabled: true,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not persist a baseUrl for non-Ollama providers', async () => {
    const service = makeService(prisma);
    await service.upsert('user-1', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-x',
      baseUrl: 'http://evil.internal',
      priority: 0,
      enabled: true,
    } as never);
    expect(prisma.aiProviderConfig.create.mock.calls[0][0].data.baseUrl).toBeNull();
  });
});

describe('AiKeyService.remove', () => {
  it('rejects removing a config the user does not own', async () => {
    const prisma = makePrisma();
    prisma.aiProviderConfig.findUnique = vi.fn().mockResolvedValue({ id: 'cfg-1', userId: 'other' });
    const service = makeService(prisma);
    await expect(service.remove('user-1', 'cfg-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws AI_CONFIG_NOT_FOUND for a missing config', async () => {
    const prisma = makePrisma();
    prisma.aiProviderConfig.findUnique = vi.fn().mockResolvedValue(null);
    const service = makeService(prisma);
    await expect(service.remove('user-1', 'missing')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'AI_CONFIG_NOT_FOUND' }),
    });
  });

  it('deletes an owned config', async () => {
    const prisma = makePrisma();
    prisma.aiProviderConfig.findUnique = vi.fn().mockResolvedValue({ id: 'cfg-1', userId: 'user-1' });
    const service = makeService(prisma);
    await expect(service.remove('user-1', 'cfg-1')).resolves.toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe('AiKeyService.list', () => {
  it('flags a stored key that can no longer be read, and never returns a key', async () => {
    const prisma = makePrisma();
    const row = { id: 'cfg', model: 'm', priority: 0, enabled: true, isAdminDefault: false, baseUrl: null };
    prisma.aiProviderConfig.findMany = vi.fn().mockResolvedValue([
      { ...row, provider: 'openai', encryptedKey: sealKey('sk-a', ENC_KEY) },
      { ...row, provider: 'openrouter', encryptedKey: encrypt('sk-b', ENC_KEY) },
      { ...row, provider: 'anthropic', encryptedKey: sealKey('sk-c', 'c'.repeat(64)) },
      { ...row, provider: 'ollama', encryptedKey: null, baseUrl: 'http://ollama:11434' },
    ]);

    const list = await makeService(prisma).list('user-1');

    expect(list.map((entry) => [entry.provider, entry.hasKey, entry.keyUnreadable])).toEqual([
      ['openai', true, false],
      // Stored before keys carried the id of their secret: still readable.
      ['openrouter', true, false],
      ['anthropic', true, true],
      ['ollama', false, false],
    ]);
    expect(JSON.stringify(list)).not.toContain('sk-');
    expect(JSON.stringify(list)).not.toContain('encryptedKey');
  });
});

describe('AiKeyService.resolveChain', () => {
  it('returns an empty chain for aiMode none', async () => {
    const service = makeService(makePrisma());
    expect(await service.resolveChain('user-1', 'none')).toEqual([]);
  });

  it('byok mode decrypts each enabled config key, ordered by priority', async () => {
    const prisma = makePrisma();
    prisma.aiProviderConfig.findMany = vi.fn().mockResolvedValue([
      { provider: 'openai', model: 'gpt-4o', priority: 0, encryptedKey: encrypt('sk-a', ENC_KEY), baseUrl: null },
    ]);
    const service = makeService(prisma);
    const chain = await service.resolveChain('user-1', 'byok');
    expect(chain).toHaveLength(1);
    expect(chain[0].apiKey).toBe('sk-a');
    expect(chain[0].mode).toBe('byok');
  });

  it('byok mode marks an entry whose key cannot be read, instead of failing the whole chain', async () => {
    const prisma = makePrisma();
    prisma.aiProviderConfig.findMany = vi.fn().mockResolvedValue([
      { provider: 'openai', model: 'gpt-4o', priority: 0, encryptedKey: sealKey('sk-a', 'c'.repeat(64)), baseUrl: null },
      { provider: 'anthropic', model: 'claude', priority: 1, encryptedKey: '00:00:00', baseUrl: null },
      { provider: 'openrouter', model: 'llama', priority: 2, encryptedKey: sealKey('sk-c', ENC_KEY), baseUrl: null },
    ]);
    const service = makeService(prisma);

    const chain = await service.resolveChain('user-1', 'byok');

    expect(chain.map((entry) => [entry.provider, entry.keyUnreadable, entry.apiKey])).toEqual([
      ['openai', true, null],
      ['anthropic', true, null],
      ['openrouter', false, 'sk-c'],
    ]);
  });

  it("byok mode marks a user's entries as theirs, and an Ollama entry on the operator's host as the operator's to pay for", async () => {
    const prisma = makePrisma();
    prisma.aiProviderConfig.findMany = vi.fn().mockResolvedValue([
      { provider: 'ollama', model: 'own', priority: 0, encryptedKey: null, baseUrl: 'http://gpu-box:11434' },
      { provider: 'ollama', model: 'shared', priority: 1, encryptedKey: null, baseUrl: 'http://OLLAMA.:11434/' },
      { provider: 'ollama', model: 'no-address', priority: 2, encryptedKey: null, baseUrl: null },
    ]);
    const service = makeService(prisma, makeConfig({ OLLAMA_BASE_URL: 'http://ollama:11434' }));

    const chain = await service.resolveChain('user-1', 'byok');

    expect(chain.map((entry) => [entry.model, entry.owner, entry.mode])).toEqual([
      ['own', 'user', 'byok'],
      ['shared', 'user', 'admin'],
      // An entry without an address is dialled at the operator's.
      ['no-address', 'user', 'admin'],
    ]);
  });

  it('admin mode builds a single-entry chain from env provider+model', async () => {
    const config = makeConfig({
      AI_DEFAULT_PROVIDER: 'openai',
      AI_DEFAULT_MODEL: 'gpt-4o-mini',
      OPENAI_API_KEY: 'sk-admin',
    });
    const service = makeService(makePrisma(), config);
    const chain = await service.resolveChain('user-1', 'admin');
    expect(chain).toEqual([
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-admin',
        owner: 'operator',
        mode: 'admin',
      }),
    ]);
  });

  it('admin mode returns an empty chain when no env provider is configured', async () => {
    const service = makeService(makePrisma());
    expect(await service.resolveChain('user-1', 'admin')).toEqual([]);
  });
});
