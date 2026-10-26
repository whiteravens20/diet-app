// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Locale } from '@diet-app/shared';
import nodemailer, { type Transporter } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';
import type { Env } from '../config/env.js';
import {
  emailChangedEmail,
  emailChangeEmail,
  emailChangeRequestedEmail,
  emailVerificationEmail,
  passwordChangedEmail,
  passwordResetEmail,
  recoveryCodeUsedEmail,
  type RenderedEmail,
  secondFactorFailedEmail,
  secondFactorOffEmail,
  secondFactorOnEmail,
} from './mail-templates.js';

/** How many mails one address is sent in a day, whoever asks for them. */
export const MAILS_PER_ADDRESS_PER_DAY = 10;

const DAY_MS = 86_400_000;

/**
 * How the connection to the mail server is made. A port that begins in the
 * clear (587, 25) must be upgraded with STARTTLS before the password or a
 * mail goes over it: a server that does not offer it, or a network that
 * strips the offer, ends the send instead of taking the mail unencrypted.
 * `SMTP_REQUIRE_TLS=false` says that the path to the server is trusted, as a
 * relay on the same host is. The waits are seconds: the library's own are
 * two and ten minutes.
 */
export function transportOptions(config: ConfigService<Env, true>): SMTPTransportOptions {
  const port = config.get('SMTP_PORT', { infer: true });
  const user = config.get('SMTP_USER', { infer: true });
  // 465 is TLS from the first byte; everything else upgrades.
  const secure = port === 465;
  return {
    host: config.get('SMTP_HOST', { infer: true }),
    port,
    secure,
    requireTLS: !secure && config.get('SMTP_REQUIRE_TLS', { infer: true }),
    auth: user ? { user, pass: config.get('SMTP_PASSWORD', { infer: true }) } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  };
}

/**
 * Transactional mail. Fully optional: "configured" means `SMTP_HOST` is set.
 * `enabled` is the single source of truth the rest of the app reads to decide
 * between the email-confirmation flow and the immediate "od ręki" path.
 *
 * **A mail never holds up or fails the request that causes it.** Every
 * `send*` hands the mail over and returns: it goes out after the request was
 * answered, and a mail server that is slow, down or refuses is written to the
 * log and nowhere else. What a request answers, and how long it takes, then
 * says nothing about the mail server, nor about whether an address has an
 * account.
 *
 * One address is sent at most `MAILS_PER_ADDRESS_PER_DAY` mails in a day,
 * whichever account or visitor causes them: the instance is not a way to
 * fill somebody's mailbox. The count is kept in this process.
 *
 * When disabled every `send*` sends nothing. Outside production the message is
 * logged instead, link included, so a reset link can be followed from the API
 * log during development. In production only the fact is logged: a reset link
 * is a credential, and the log is not the place for one. Callers that require
 * mail (verification, email-change) gate on `enabled` before they ever reach
 * here.
 */
@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly logger = new Logger(MailService.name);
  /** What mail goes out through: built from the SMTP settings at the first send. A test puts its own here. */
  transport: Transporter | null = null;
  /** The work handed over that has not ended yet. */
  private readonly pending = new Set<Promise<void>>();
  /** When each address was last sent mail, by a hash of the address: no address is kept here in the clear. */
  private readonly sentTo = new Map<string, number[]>();

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** True when SMTP is configured and mail can actually be delivered. */
  get enabled(): boolean {
    return (this.config.get('SMTP_HOST', { infer: true }) ?? '').trim().length > 0;
  }

  sendPasswordReset(to: string, link: string, locale: Locale): void {
    this.send(to, passwordResetEmail[locale]({ link }), 'password reset', link);
  }

  sendEmailVerification(to: string, link: string, locale: Locale): void {
    this.send(to, emailVerificationEmail[locale]({ link }), 'email verification', link);
  }

  sendEmailChange(to: string, link: string, locale: Locale): void {
    this.send(to, emailChangeEmail[locale]({ link }), 'email change', link);
  }

  sendPasswordChangedNotice(to: string, locale: Locale): void {
    this.send(to, passwordChangedEmail[locale]({}), 'password-changed notice');
  }

  /** To the address an account has: a change to `newAddress` was asked for. */
  sendEmailChangeRequestedNotice(to: string, newAddress: string, locale: Locale): void {
    this.send(
      to,
      emailChangeRequestedEmail[locale]({ newAddress }),
      'address-change-requested notice',
    );
  }

  /** To the address an account had: it is `newAddress` now. */
  sendEmailChangedNotice(to: string, newAddress: string, locale: Locale): void {
    this.send(to, emailChangedEmail[locale]({ newAddress }), 'address-changed notice');
  }

  sendSecondFactorOnNotice(to: string, locale: Locale): void {
    this.send(to, secondFactorOnEmail[locale]({}), 'second-factor-on notice');
  }

  /** `by`: the holder of the account switched it off, or the operator did for them. */
  sendSecondFactorOffNotice(to: string, by: 'holder' | 'operator', locale: Locale): void {
    this.send(to, secondFactorOffEmail[locale]({ by }), 'second-factor-off notice');
  }

  sendRecoveryCodeUsedNotice(to: string, left: number, locale: Locale): void {
    this.send(to, recoveryCodeUsedEmail[locale]({ left }), 'recovery-code-used notice');
  }

  sendSecondFactorFailedNotice(to: string, locale: Locale): void {
    this.send(to, secondFactorFailedEmail[locale]({}), 'wrong-codes notice');
  }

  /**
   * Do `work` after the caller has gone on: work that ends in a mail and that
   * the request must not wait for, nor fail with. What it throws is logged
   * under `kind`.
   */
  later(kind: string, work: () => Promise<void>): void {
    const running: Promise<void> = work()
      .catch((err: unknown) => this.logger.error(`${kind} mail was not sent: ${reasonOf(err)}`))
      .finally(() => this.pending.delete(running));
    this.pending.add(running);
  }

  /** Resolves once everything handed over so far has gone out or failed. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  /** A mail that was handed over is not lost because the process is told to stop. */
  async onApplicationShutdown(): Promise<void> {
    await this.idle();
  }

  private send(to: string, email: RenderedEmail, kind: string, link?: string): void {
    this.later(kind, () => this.deliver(to, email, kind, link));
  }

  /** Sends one email, or only logs when SMTP is off (see the class comment for what is logged where). */
  private async deliver(
    to: string,
    email: RenderedEmail,
    kind: string,
    link?: string,
  ): Promise<void> {
    if (!this.enabled) {
      if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
        this.logger.warn(`[mail disabled] ${kind} not sent: SMTP is not configured`);
      } else {
        this.logger.log(`[mail disabled] ${kind} → ${to}${link ? `: ${link}` : ''}`);
      }
      return;
    }
    if (!this.mayBeSent(to)) {
      this.logger.warn(
        `${kind} mail was not sent: its address has been sent ${MAILS_PER_ADDRESS_PER_DAY} mails in the last day`,
      );
      return;
    }
    await this.getTransport().sendMail({
      from: this.config.get('SMTP_FROM', { infer: true }),
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }

  /** Count a mail to `to` and say whether the address may still be sent one today. */
  private mayBeSent(to: string): boolean {
    const now = Date.now();
    const key = createHash('sha256').update(to.trim().toLowerCase()).digest('hex');
    const recent = (this.sentTo.get(key) ?? []).filter((at) => now - at < DAY_MS);
    if (recent.length >= MAILS_PER_ADDRESS_PER_DAY) {
      this.sentTo.set(key, recent);
      return false;
    }
    this.sentTo.set(key, [...recent, now]);
    // What nobody was sent for a day is forgotten, so the list does not grow for ever.
    if (this.sentTo.size > 10_000) {
      for (const [address, times] of this.sentTo)
        if (times.every((at) => now - at >= DAY_MS)) this.sentTo.delete(address);
    }
    return true;
  }

  /** Builds the nodemailer transport lazily from the SMTP_* env. */
  private getTransport(): Transporter {
    this.transport ??= nodemailer.createTransport(transportOptions(this.config));
    return this.transport;
  }
}

/** What went wrong with a send, short enough for a log line and without the address the mail was for. */
function reasonOf(err: unknown): string {
  const error = err as { code?: unknown; message?: unknown };
  const text = typeof error?.message === 'string' ? error.message : String(err);
  return `${typeof error?.code === 'string' ? `${error.code}: ` : ''}${text.replace(/\S+@\S+/g, '<address>').slice(0, 200)}`;
}
