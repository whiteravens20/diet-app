// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for MailService. With SMTP off: what reaches the log. A reset
 * link is a credential, so it may appear in the log during development and
 * never in production. With SMTP on: that a mail never holds up or fails
 * whoever asked for it, how many one address is sent, and how the connection
 * to the mail server is made.
 */
import { Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAILS_PER_ADDRESS_PER_DAY, MailService, transportOptions } from './mail.service.js';

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

    const svc = makeService({ SMTP_HOST: '', NODE_ENV: 'development' });
    svc.sendPasswordReset(TO, LINK, 'en');
    await svc.idle();

    expect(log).toHaveBeenCalledWith(`[mail disabled] password reset → ${TO}: ${LINK}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs neither the link nor the recipient in production', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = makeService({ SMTP_HOST: '', NODE_ENV: 'production' });

    svc.sendPasswordReset(TO, LINK, 'en');
    svc.sendEmailVerification(TO, LINK, 'pl');
    svc.sendEmailChange(TO, LINK, 'en');
    svc.sendPasswordChangedNotice(TO, 'en');
    await svc.idle();

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
    const written = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(written).toContain('[mail disabled] password reset not sent: SMTP is not configured');
    expect(written).not.toContain(TO);
    expect(written).not.toContain(LINK);
    expect(written).not.toContain('token=');
  });
});

describe('MailService with SMTP on', () => {
  const ON = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: 587, SMTP_FROM: 'Diet App <no-reply@example.test>', SMTP_REQUIRE_TLS: true, NODE_ENV: 'production' };

  /** The service with a transport that records what it is given, and sends when `release` is called (at once without it). */
  function sending(hold = false) {
    const svc = makeService(ON);
    const sent: { to: string; subject: string }[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    svc.transport = {
      sendMail: async (message: { to: string; subject: string }) => {
        if (hold) await held;
        sent.push({ to: message.to, subject: message.subject });
      },
    } as unknown as Transporter;
    return { svc, sent, release };
  }

  it('hands a mail over without waiting for the mail server', async () => {
    const { svc, sent, release } = sending(true);

    svc.sendPasswordReset(TO, LINK, 'en');

    // The call is back, and the server has not taken the mail yet.
    expect(sent).toEqual([]);
    release();
    await svc.idle();
    expect(sent).toEqual([{ to: TO, subject: 'Reset your Diet App password' }]);
  });

  it('keeps a mail server that fails to itself: nothing is thrown, and the log says what was not sent, without the address or the link', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const svc = makeService(ON);
    svc.transport = { sendMail: () => Promise.reject(new Error('connect ECONNREFUSED 203.0.113.5:587')) } as unknown as Transporter;

    expect(() => svc.sendPasswordReset(TO, LINK, 'en')).not.toThrow();
    await svc.idle();

    expect(error).toHaveBeenCalledTimes(1);
    const written = String(error.mock.calls[0]![0]);
    expect(written).toContain('password reset mail was not sent');
    expect(written).toContain('ECONNREFUSED');
    expect(written).not.toContain(TO);
    expect(written).not.toContain('token=');
  });

  it('sends one address no more than a handful of mails a day, however it is spelled, and says so in the log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, sent } = sending();

    for (let i = 0; i < MAILS_PER_ADDRESS_PER_DAY + 3; i += 1) svc.sendEmailVerification(i % 2 ? TO : ` ${TO.toUpperCase()}`, LINK, 'en');
    svc.sendEmailVerification('somebody-else@example.test', LINK, 'en');
    await svc.idle();

    expect(sent.filter((mail) => mail.to.trim().toLowerCase() === TO)).toHaveLength(MAILS_PER_ADDRESS_PER_DAY);
    expect(sent.filter((mail) => mail.to === 'somebody-else@example.test')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]![0])).not.toContain('example.test');
  });

  it('sends that address mail again a day later', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-05T08:00:00Z') });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { svc, sent } = sending();
      for (let i = 0; i < MAILS_PER_ADDRESS_PER_DAY + 1; i += 1) svc.sendEmailVerification(TO, LINK, 'en');
      await svc.idle();
      expect(sent).toHaveLength(MAILS_PER_ADDRESS_PER_DAY);

      vi.setSystemTime(new Date('2026-01-06T08:00:01Z'));
      svc.sendEmailVerification(TO, LINK, 'en');
      await svc.idle();

      expect(sent).toHaveLength(MAILS_PER_ADDRESS_PER_DAY + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for ever to hear of a mail that went out', async () => {
    const { svc, sent, release } = sending(true);
    svc.sendPasswordChangedNotice(TO, 'pl');

    let idle = false;
    void svc.idle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await svc.idle();
    expect(sent).toHaveLength(1);
  });
});

describe('the connection to the mail server', () => {
  const settings = (over: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: 587, SMTP_USER: 'mailer', SMTP_PASSWORD: 'secret', SMTP_REQUIRE_TLS: true, ...over };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
    return transportOptions({ get: (k: string) => values[k] } as any);
  };

  it('is encrypted before anything is said on it: STARTTLS is required on a port that begins in the clear', () => {
    expect(settings()).toMatchObject({ host: 'smtp.example.test', port: 587, secure: false, requireTLS: true, auth: { user: 'mailer', pass: 'secret' } });
  });

  it('is encrypted from the first byte on port 465', () => {
    expect(settings({ SMTP_PORT: 465 })).toMatchObject({ secure: true, requireTLS: false });
  });

  it('may be left in the clear only where the operator says so', () => {
    expect(settings({ SMTP_REQUIRE_TLS: false })).toMatchObject({ secure: false, requireTLS: false });
  });

  it('gives up on a server that does not answer within seconds, not minutes', () => {
    const { connectionTimeout, greetingTimeout, socketTimeout } = settings();

    for (const wait of [connectionTimeout, greetingTimeout, socketTimeout]) {
      expect(wait).toBeGreaterThanOrEqual(5_000);
      expect(wait).toBeLessThanOrEqual(20_000);
    }
  });

  it('signs in only where a user is set', () => {
    expect(settings({ SMTP_USER: undefined }).auth).toBeUndefined();
  });
});

