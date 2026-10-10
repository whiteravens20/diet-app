// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKey } from '../common/crypto.js';
import { validateEnv, type Env } from './env.js';
import { resetDatabase } from '../testing/database.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/**
 * Settings the env template ships with nothing after the `=`. Compose hands
 * each of them to the container as an empty string, which is how a fresh
 * install runs.
 */
const BLANK = [
  'REVIEWER_SESSION_SECRET',
  'SHIP_DOWNLOAD_TOKEN_SECRET',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
  'SUPPORT_URL',
  'OPERATOR_CONTACT',
  'APP_VERSION',
  'FDC_API_KEY',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'OLLAMA_ALLOWED_HOSTS',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'OVERRIDES_PULL_TOKEN',
  'SHIP_UPSTREAM_GH_TOKEN',
  'SHIP_UPSTREAM_GIT_AUTHOR_NAME',
  'SHIP_UPSTREAM_GIT_AUTHOR_EMAIL',
];

describe('settings left blank in the environment', () => {
  let t: TestApp;
  const basic = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };

  beforeAll(async () => {
    t = await createTestApp(Object.fromEntries(BLANK.map((key) => [key, ''])));
    await resetDatabase(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('are the ones the template leaves blank', () => {
    const template = readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8');
    const blankInTemplate = [...template.matchAll(/^([A-Z0-9_]+)=[ \t]*$/gm)].map((match) => match[1]);

    expect(blankInTemplate).toEqual(expect.arrayContaining(BLANK));
  });

  it('read as if they were not there at all, every one of them', () => {
    const config = t.app.get(ConfigService);
    // What validation makes of the same environment without them: nothing, or the setting's default.
    const without = validateEnv(Object.fromEntries(Object.entries(process.env).filter(([key]) => !BLANK.includes(key))));

    for (const key of BLANK) expect(config.get(key), key).toBe(without[key as keyof Env]);
    expect(config.get('REVIEWER_SESSION_SECRET')).toBeUndefined();
    expect(config.get('FDC_API_KEY')).toBe('DEMO_KEY');
  });

  it('publish nothing about the operator, and the package version', async () => {
    const { version } = JSON.parse(readFileSync(resolve(__dirname, '../../../../package.json'), 'utf8')) as { version: string };

    const { body } = await t.http().get('/api/config').expect(200);

    expect(body.turnstile).toEqual({ enabled: false, siteKey: null });
    expect(body.instance).toEqual({ supportUrl: null, operatorContact: null, version });
  });

  it('let a reviewer sign in, with a cookie signed by a key of its own', async () => {
    await t.http().patch('/api/admin/instance-settings').set(basic).send({ reviewerEnabled: true, reviewerPassword: 'Reviewers-Passw0rd' }).expect(200);

    const res = await t.http().post('/api/review/auth').send({ password: 'Reviewers-Passw0rd', label: 'pl reviewer' });

    expect(res.status).toBe(204);
    const cookie = /reviewer_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]!;
    const jwt = t.app.get(JwtService, { strict: false });
    const config = t.app.get(ConfigService);
    const own = deriveKey(config.get('DATA_ENCRYPTION_SECRET'), 'reviewer-session');
    expect(jwt.verify(decodeURIComponent(cookie), { secret: own })).toMatchObject({ kind: 'reviewer', label: 'pl reviewer' });
    // Never the key of users' access tokens.
    expect(() => jwt.verify(decodeURIComponent(cookie), { secret: config.get('JWT_ACCESS_SECRET') })).toThrow();
  });
});
