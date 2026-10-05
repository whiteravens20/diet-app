// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Locale } from '@diet-app/shared';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';
import {
  emailChangeEmail,
  emailVerificationEmail,
  passwordChangedEmail,
  passwordResetEmail,
  type RenderedEmail,
} from './mail-templates.js';

/**
 * Transactional mail. Fully optional: "configured" means `SMTP_HOST` is set.
 * `enabled` is the single source of truth the rest of the app reads to decide
 * between the email-confirmation flow and the immediate "od ręki" path.
 *
 * When disabled every `send*` sends nothing. Outside production the message is
 * logged instead, link included, so a reset link can be followed from the API
 * log during development. In production only the fact is logged: a reset link
 * is a credential, and the log is not the place for one. Callers that require
 * mail (verification, email-change) gate on `enabled` before they ever reach
 * here.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transport: Transporter | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** True when SMTP is configured and mail can actually be delivered. */
  get enabled(): boolean {
    return (this.config.get('SMTP_HOST', { infer: true }) ?? '').trim().length > 0;
  }

  async sendPasswordReset(to: string, link: string, locale: Locale): Promise<void> {
    await this.deliver(to, passwordResetEmail[locale]({ link }), 'password reset', link);
  }

  async sendEmailVerification(to: string, link: string, locale: Locale): Promise<void> {
    await this.deliver(to, emailVerificationEmail[locale]({ link }), 'email verification', link);
  }

  async sendEmailChange(to: string, link: string, locale: Locale): Promise<void> {
    await this.deliver(to, emailChangeEmail[locale]({ link }), 'email change', link);
  }

  async sendPasswordChangedNotice(to: string, locale: Locale): Promise<void> {
    await this.deliver(to, passwordChangedEmail[locale]({}), 'password-changed notice');
  }

  /**
   * Sends one email, or only logs when SMTP is off (see the class comment for
   * what is logged where). Throws on a genuine SMTP failure so flows that
   * depend on delivery (verification, email change) can surface it;
   * best-effort callers (the password-changed notice) wrap this in their own
   * catch.
   */
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
    const transport = this.getTransport();
    await transport.sendMail({
      from: this.config.get('SMTP_FROM', { infer: true }),
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }

  /** Builds the nodemailer transport lazily from the SMTP_* env. */
  private getTransport(): Transporter {
    if (this.transport) return this.transport;
    const host = this.config.get('SMTP_HOST', { infer: true });
    const port = this.config.get('SMTP_PORT', { infer: true });
    const user = this.config.get('SMTP_USER', { infer: true });
    const password = this.config.get('SMTP_PASSWORD', { infer: true });
    this.transport = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; everything else (587/25) upgrades via STARTTLS.
      secure: port === 465,
      auth: user ? { user, pass: password } : undefined,
    });
    return this.transport;
  }
}
