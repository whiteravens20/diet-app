// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for MailService with SMTP off. Focus: what reaches the log. A
 * reset link is a credential, so it may appear in the log during development
 * and never in production.
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.service.js';

const TO = 'user@example.test';
const LINK = 'https://app.example.test/reset-password?token=0123456789abcdef';

function makeService(values: Record<string, unknown>): MailService {
  const config = { get: (k: string) => values[k] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return new MailService(config as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MailService with SMTP off', () => {
  it('reports itself disabled when SMTP_HOST is blank', () => {
    expect(makeService({ SMTP_HOST: '' }).enabled).toBe(false);
    expect(makeService({ SMTP_HOST: '   ' }).enabled).toBe(false);
    expect(makeService({ SMTP_HOST: 'smtp.example.test' }).enabled).toBe(true);
  });

  it('logs the reset link outside production', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await makeService({ SMTP_HOST: '', NODE_ENV: 'development' }).sendPasswordReset(TO, LINK, 'en');

    expect(log).toHaveBeenCalledWith(`[mail disabled] password reset → ${TO}: ${LINK}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs neither the link nor the recipient in production', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = makeService({ SMTP_HOST: '', NODE_ENV: 'production' });

    await svc.sendPasswordReset(TO, LINK, 'en');
    await svc.sendEmailVerification(TO, LINK, 'pl');
    await svc.sendEmailChange(TO, LINK, 'en');
    await svc.sendPasswordChangedNotice(TO, 'en');

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
    const written = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(written).toContain('[mail disabled] password reset not sent: SMTP is not configured');
    expect(written).not.toContain(TO);
    expect(written).not.toContain(LINK);
    expect(written).not.toContain('token=');
  });
});
