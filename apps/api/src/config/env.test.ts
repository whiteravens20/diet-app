// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describePosture, envSchema, validateEnv } from './env.js';

/** A complete, valid environment as an operator would have after generating secrets. */
const valid = (overrides: Record<string, string | undefined> = {}): Record<string, unknown> => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://diet:diet@postgres:5432/diet_app',
  JWT_ACCESS_SECRET: '6f1c9a04b7d2e85a3c41f09d7be26a58c3d90e17f4a2b6c8',
  AI_KEY_ENCRYPTION_SECRET: '3a7f19c2e84b06d5f1a92c7e4b8d03f6a15c9e27d4b80f36c1a5e97d2b4f8063',
  DATA_ENCRYPTION_SECRET: 'c94e1b7a26f8d03559ae4c17b2f60d8e3a71c5f924be06d8a3f17c92e5b40d16',
  ...overrides,
});

/** The keys and values of the shipped template, exactly as a parser of `.env` files reads them. */
function template(): Record<string, string> {
  const text = readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8');
  const entries: [string, string][] = [];
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.replace(/\s+#.*$/, '').replace(/^'(.*)'$/, '$1');
    entries.push([match[1]!, value]);
  }
  return Object.fromEntries(entries);
}

describe('validateEnv', () => {
  it('accepts a generated configuration and applies the defaults', () => {
    const env = validateEnv(valid());
    expect(env).toMatchObject({ API_PORT: 4000, RATE_LIMIT_MAX: 120, FDC_API_KEY: 'DEMO_KEY', SWAGGER_ENABLED: false });
  });

  it('reads a blank optional key as not set', () => {
    const env = validateEnv(
      valid({
        REVIEWER_SESSION_SECRET: '',
        SHIP_DOWNLOAD_TOKEN_SECRET: '   ',
        OVERRIDES_PULL_TOKEN: '',
        FDC_API_KEY: '',
        OLLAMA_BASE_URL: '',
        SMTP_HOST: '',
        RATE_LIMIT_MAX: '',
      }),
    );
    expect(env.REVIEWER_SESSION_SECRET).toBeUndefined();
    expect(env.SHIP_DOWNLOAD_TOKEN_SECRET).toBeUndefined();
    expect(env.OVERRIDES_PULL_TOKEN).toBeUndefined();
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.FDC_API_KEY).toBe('DEMO_KEY');
    expect(env.OLLAMA_BASE_URL).toBe('http://localhost:11434');
    expect(env.RATE_LIMIT_MAX).toBe(120);
  });

  it('still requires a required key that was left blank', () => {
    expect(() => validateEnv(valid({ DATABASE_URL: '' }))).toThrow(/DATABASE_URL/);
  });

  it.each([
    ['RATE_LIMIT_MAX', '0'],
    ['RATE_LIMIT_WINDOW', '0'],
    ['JWT_ACCESS_TTL', '-5'],
    ['JWT_REFRESH_TTL', '0'],
    ['API_PORT', '70000'],
    ['SMTP_PORT', '0'],
  ])('refuses %s=%s', (key, value) => {
    expect(() => validateEnv(valid({ [key]: value }))).toThrow(new RegExp(key));
  });

  it.each([
    ['JWT_ACCESS_SECRET', 'change-me-access-secret-change-me-access-secret'],
    ['JWT_ACCESS_SECRET', 'short-but-random-9f2c'],
    ['AI_KEY_ENCRYPTION_SECRET', '0'.repeat(64)],
    ['DATA_ENCRYPTION_SECRET', '1'.repeat(64)],
    ['REVIEWER_SESSION_SECRET', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ])('refuses to start on a weak or template %s', (key, value) => {
    expect(() => validateEnv(valid({ [key]: value }))).toThrow(new RegExp(`not secret[\\s\\S]*${key}`));
    expect(() => validateEnv(valid({ [key]: value, NODE_ENV: 'development' }))).toThrow(/not secret/);
  });

  it('refuses two purposes sharing one secret', () => {
    const base = valid();
    expect(() => validateEnv({ ...base, AI_KEY_ENCRYPTION_SECRET: base.DATA_ENCRYPTION_SECRET })).toThrow(/must differ/);
    expect(() => validateEnv({ ...base, REVIEWER_SESSION_SECRET: base.JWT_ACCESS_SECRET })).toThrow(/must differ/);
  });

  it('lets a test run use fixed secrets', () => {
    expect(() => validateEnv(valid({ NODE_ENV: 'test', AI_KEY_ENCRYPTION_SECRET: 'a1'.repeat(32) }))).not.toThrow();
  });

  it('turns Swagger on outside production unless told otherwise', () => {
    expect(validateEnv(valid({ NODE_ENV: 'development' })).SWAGGER_ENABLED).toBe(true);
    expect(validateEnv(valid({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' })).SWAGGER_ENABLED).toBe(false);
    expect(validateEnv(valid({ SWAGGER_ENABLED: 'true' })).SWAGGER_ENABLED).toBe(true);
  });
});

describe('the shipped .env.example', () => {
  it('does not start as it is: it carries no secret', () => {
    expect(() => validateEnv(template())).toThrow(/JWT_ACCESS_SECRET|AI_KEY_ENCRYPTION_SECRET|DATA_ENCRYPTION_SECRET/);
  });

  it('starts once the three secrets are generated, with nothing else to fill in', () => {
    const secrets = valid();
    const env = validateEnv({
      ...template(),
      JWT_ACCESS_SECRET: secrets.JWT_ACCESS_SECRET,
      AI_KEY_ENCRYPTION_SECRET: secrets.AI_KEY_ENCRYPTION_SECRET,
      DATA_ENCRYPTION_SECRET: secrets.DATA_ENCRYPTION_SECRET,
    });
    expect(env.NODE_ENV).toBe('development');
  });

  it('names only settings the application or the Compose files read', () => {
    // Read by Compose or by the web build, not by the API.
    const elsewhere = new Set([
      'API_URL',
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'POSTGRES_DB',
      'WEB_PORT',
      'IMAGE_TAG',
    ]);
    const known = new Set(Object.keys(envSchema.shape));
    expect(Object.keys(template()).filter((key) => !known.has(key) && !elsewhere.has(key))).toEqual([]);
  });

  it('names every setting the application reads', () => {
    const inTemplate = new Set(Object.keys(template()));
    expect(Object.keys(envSchema.shape).filter((key) => !inTemplate.has(key))).toEqual([]);
  });
});

describe('describePosture', () => {
  const env = () => validateEnv(valid({ APP_URL: 'https://diet.example.org', ADMIN_PASSWORD: 'a-real-admin-password' }));

  it('reports a sound setup without a warning', () => {
    expect(describePosture(env()).filter((line) => line.startsWith('!'))).toEqual([]);
  });

  it('states both limits on the operator\'s AI provider when there is one', () => {
    expect(describePosture(env())).toContain('operator AI provider: none');
    expect(describePosture({ ...env(), AI_DEFAULT_PROVIDER: 'openai' })).toContain(
      'operator AI provider: openai, at most 40 calls per user and 1000 for the whole instance in 30 days',
    );
  });

  it('warns about a public origin that is not https and about Swagger in production', () => {
    const lines = describePosture({ ...env(), APP_URL: 'http://192.0.2.10:3000', SWAGGER_ENABLED: true });
    expect(lines.filter((line) => line.startsWith('!'))).toHaveLength(2);
  });

  it('warns about an admin password that is short, without repeating it or its length', () => {
    const lines = describePosture({ ...env(), ADMIN_PASSWORD: 'diet2026' });

    expect(lines.filter((line) => line.startsWith('!'))).toEqual([
      '! admin panel: enabled with a password shorter than 16 characters; it guards the AI keys and the catalogue',
    ]);
    expect(lines.join('\n')).not.toContain('diet2026');
    expect(lines.join('\n')).not.toMatch(/\b8 characters/);
  });

  it('says nothing about an admin password of the advised length', () => {
    const lines = describePosture({ ...env(), ADMIN_PASSWORD: 'a'.repeat(16) });

    expect(lines.filter((line) => line.startsWith('!'))).toEqual([]);
    expect(lines).toContain('admin panel: enabled');
  });

  it('says whose word is taken for a client\'s address', () => {
    expect(describePosture(env()).at(-1)).toMatch(/^client address: that of the connection/);
    expect(describePosture({ ...env(), TRUST_PROXY: '1' }).at(-1)).toBe('client address: from X-Forwarded-For, written by 1 trusted proxy');
  });
});

describe('TRUST_PROXY in the environment', () => {
  it('is refused with a reason when it is not a number of proxies or their addresses', () => {
    expect(() => validateEnv(valid({ TRUST_PROXY: 'true' }))).toThrow(/TRUST_PROXY: "true" would believe/);
    expect(() => validateEnv(valid({ TRUST_PROXY: 'traefik' }))).toThrow(/TRUST_PROXY: "traefik" is neither/);
  });

  it('is accepted as a number, as a list, and left out', () => {
    expect(validateEnv(valid({ TRUST_PROXY: '1' })).TRUST_PROXY).toBe('1');
    expect(validateEnv(valid({ TRUST_PROXY: '10.0.0.0/8, loopback' })).TRUST_PROXY).toBe('10.0.0.0/8, loopback');
    expect(validateEnv(valid({})).TRUST_PROXY).toBeUndefined();
  });
});

describe('the environment reference', () => {
  it('documents every setting the application reads', () => {
    const reference = readFileSync(resolve(__dirname, '../../../../docs/ops/env-reference.md'), 'utf8');
    expect(Object.keys(envSchema.shape).filter((key) => !reference.includes(`\`${key}\``))).toEqual([]);
  });
});
