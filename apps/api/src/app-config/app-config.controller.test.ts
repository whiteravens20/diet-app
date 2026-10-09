// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { TurnstileService } from '../auth/turnstile.service.js';
import type { Env } from '../config/env.js';
import type { MailService } from '../mail/mail.service.js';
import { AppConfigController } from './app-config.controller.js';

function configOf(env: Partial<Env>) {
  const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  const controller = new AppConfigController(
    config,
    { enabled: false } as TurnstileService,
    { enabled: true } as MailService,
  );
  return controller.get();
}

const packageVersion = (
  JSON.parse(readFileSync(resolve(__dirname, '../../../../package.json'), 'utf8')) as { version: string }
).version;

describe('GET /api/config', () => {
  it('publishes nothing about the operator unless they set it, and the package version', () => {
    expect(configOf({ OLLAMA_USER_POLICY: 'allowlist' }).instance).toEqual({
      supportUrl: null,
      operatorContact: null,
      version: packageVersion,
    });
  });

  it('publishes what the operator set', () => {
    const { instance } = configOf({
      OLLAMA_USER_POLICY: 'off',
      SUPPORT_URL: 'https://example.org/support',
      OPERATOR_CONTACT: 'ops@example.org',
      APP_VERSION: '2026.10-a1b2c3d',
    });
    expect(instance).toEqual({
      supportUrl: 'https://example.org/support',
      operatorContact: 'ops@example.org',
      version: '2026.10-a1b2c3d',
    });
  });

  it('never carries a secret', () => {
    const body = JSON.stringify(configOf({ TURNSTILE_SECRET_KEY: 'turnstile-secret', JWT_ACCESS_SECRET: 'jwt-secret' }));
    expect(body).not.toContain('turnstile-secret');
    expect(body).not.toContain('jwt-secret');
  });
});
