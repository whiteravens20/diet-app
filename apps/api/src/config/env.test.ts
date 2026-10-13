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
    expect(env).toMatchObject({ API_PORT: 4000, RATE_LIMIT_MAX: 120, FDC_API_KEY: 'DEMO_KEY', SWAGGER_ENABLED: false, MAX_PROFILES_PER_ACCOUNT: 2 });
  });

  it('reads a blank optional key as not set', () => {
    const env = validateEnv(
      valid({
        REVIEWER_SESSION_SECRET: '   ',
        OVERRIDES_PULL_TOKEN: '',
        FDC_API_KEY: '',
        OLLAMA_BASE_URL: '',
        SMTP_HOST: '',
        RATE_LIMIT_MAX: '',
      }),
    );
    expect(env.REVIEWER_SESSION_SECRET).toBeUndefined();
    expect(env.OVERRIDES_PULL_TOKEN).toBeUndefined();
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.FDC_API_KEY).toBe('DEMO_KEY');
    expect(env.OLLAMA_BASE_URL).toBe('http://localhost:11434');
    expect(env.RATE_LIMIT_MAX).toBe(120);
  });

  it('takes the number of profiles an account may hold from the operator', () => {
    expect(validateEnv(valid({ MAX_PROFILES_PER_ACCOUNT: '5' })).MAX_PROFILES_PER_ACCOUNT).toBe(5);
    expect(validateEnv(valid({ MAX_PROFILES_PER_ACCOUNT: '' })).MAX_PROFILES_PER_ACCOUNT).toBe(2);
  });

  it('times the statements of the database only when it is told from how many milliseconds one is slow', () => {
    expect(validateEnv(valid({ SLOW_QUERY_MS: '50' })).SLOW_QUERY_MS).toBe(50);
    expect(validateEnv(valid({ SLOW_QUERY_MS: '' })).SLOW_QUERY_MS).toBeUndefined();
    expect(validateEnv(valid()).SLOW_QUERY_MS).toBeUndefined();
  });

  it('takes the most a recipe repeats in a plan that names no number from the operator, and none when it is left out', () => {
    expect(validateEnv(valid({ DEFAULT_MAX_REPEATS_PER_RECIPE: '3' })).DEFAULT_MAX_REPEATS_PER_RECIPE).toBe(3);
    expect(validateEnv(valid({ DEFAULT_MAX_REPEATS_PER_RECIPE: '' })).DEFAULT_MAX_REPEATS_PER_RECIPE).toBeUndefined();
    expect(validateEnv(valid()).DEFAULT_MAX_REPEATS_PER_RECIPE).toBeUndefined();
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
    // An account has at least one profile to plan for, and an instance allows no more than the contract knows.
    ['MAX_PROFILES_PER_ACCOUNT', '0'],
    ['MAX_PROFILES_PER_ACCOUNT', '21'],
    ['MAX_PROFILES_PER_ACCOUNT', '2.5'],
    // A recipe is in a plan once at least, and no more often than the longest plan has days.
    ['DEFAULT_MAX_REPEATS_PER_RECIPE', '0'],
    ['DEFAULT_MAX_REPEATS_PER_RECIPE', '29'],
    ['DEFAULT_MAX_REPEATS_PER_RECIPE', '1.5'],
    // A statement is slow from a whole millisecond on, and not from more than ten minutes.
    ['SLOW_QUERY_MS', '0'],
    ['SLOW_QUERY_MS', '600001'],
    ['SLOW_QUERY_MS', '2.5'],
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

  it('does not start in production with an admin password an account could not have', () => {
    expect(() => validateEnv(valid({ ADMIN_PASSWORD: 'elevenchars' }))).toThrow(/ADMIN_PASSWORD: is shorter than 12 characters/);
    // The message says what to do, and not what the password is.
    try {
      validateEnv(valid({ ADMIN_PASSWORD: 'elevenchars' }));
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('elevenchars');
    }
    expect(() => validateEnv(valid({ ADMIN_PASSWORD: 'twelve-chars' }))).not.toThrow();
    // An empty one keeps the panel closed, and is no problem; neither is a short one while developing.
    expect(() => validateEnv(valid({ ADMIN_PASSWORD: '' }))).not.toThrow();
    expect(() => validateEnv(valid({ NODE_ENV: 'development', ADMIN_PASSWORD: 'short' }))).not.toThrow();
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
    // Each of the three is named as what it is, with the way to make one.
    const refusal = (() => {
      try {
        validateEnv(template());
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    for (const key of ['JWT_ACCESS_SECRET', 'AI_KEY_ENCRYPTION_SECRET', 'DATA_ENCRYPTION_SECRET']) {
      expect(refusal).toContain(`  ${key}: is not set. Run \`sh scripts/init-env.sh\` for a new install`);
    }
    expect(refusal).not.toContain('received undefined');
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

describe('the data sets the food import reads', () => {
  it('are taken as a list, each of the two the importer knows', () => {
    expect(validateEnv(valid({ FDC_DATA_TYPES: 'Foundation, SR Legacy' })).FDC_DATA_TYPES).toBe('Foundation,SR Legacy');
    expect(validateEnv(valid()).FDC_DATA_TYPES).toBe('Foundation');
  });

  it('are refused at start-up when one is not a data set the importer knows', () => {
    expect(() => validateEnv(valid({ FDC_DATA_TYPES: 'Foundation,Branded' }))).toThrow(/FDC_DATA_TYPES/);
  });
});

describe('describePosture', () => {
  const env = () => validateEnv(valid({ APP_URL: 'https://diet.example.org', ADMIN_PASSWORD: 'a-real-admin-password', TRUST_PROXY: '1' }));

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

  it('warns while the switch that removes the administrator\'s second factor is left on', () => {
    expect(env().ADMIN_SECOND_FACTOR_RESET).toBe(false);

    const lines = describePosture({ ...env(), ADMIN_SECOND_FACTOR_RESET: true });

    expect(lines.filter((line) => line.startsWith('!'))).toEqual([
      '! admin panel: the second factor is removed at every start and none can be set up (ADMIN_SECOND_FACTOR_RESET=true); switch it off once the panel is open again',
    ]);
  });

  it('says nothing about an admin password of the advised length', () => {
    const lines = describePosture({ ...env(), ADMIN_PASSWORD: 'a'.repeat(16) });

    expect(lines.filter((line) => line.startsWith('!'))).toEqual([]);
    expect(lines).toContain('admin panel: enabled');
  });

  it('says whose word is taken for a client\'s address', () => {
    expect(describePosture(env()).at(-1)).toBe('client address: from X-Forwarded-For, written by 1 trusted proxy');
    expect(describePosture({ ...env(), APP_URL: 'http://192.0.2.10:3000', TRUST_PROXY: undefined }).at(-1)).toMatch(
      /^client address: that of the connection/,
    );
  });

  it('warns when the public origin is https, which only a proxy can serve, and no proxy is believed', () => {
    const lines = describePosture({ ...env(), TRUST_PROXY: undefined });

    expect(lines.filter((line) => line.startsWith('!'))).toEqual([
      '! client address: that of the proxy for every visitor alike. The public origin is https, so a proxy stands in front, and TRUST_PROXY is off: limits by address cannot tell visitors apart until it is set',
    ]);
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
