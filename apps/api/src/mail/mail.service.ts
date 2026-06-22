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
 * Transactional mail. Fully optional: "configured" means `SMTP_HOST` is set
 * (mirrors the `.env.example` convention "leave SMTP_HOST blank to log reset
 * links to stdout"). `enabled` is the single source of truth the rest of the
 * app reads to decide between the email-confirmation flow and the immediate
 * "od ręki" path.
 *
 * When disabled every `send*` is a no-op that logs the link instead of sending,
 * preserving the previous dev behaviour where reset links went to the API log.
 * Callers that require mail (verification, email-change) gate on `enabled`
 * before they ever reach here.
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
    await this.deliver(to, passwordResetEmail[locale]({ link }), `password reset → ${to}: ${link}`);
  }

  async sendEmailVerification(to: string, link: string, locale: Locale): Promise<void> {
    await this.deliver(
      to,
      emailVerificationEmail[locale]({ link }),
      `email verification → ${to}: ${link}`,
    );
  }

  async sendEmailChange(to: string, link: string, locale: Locale): Promise<void> {
    await this.deliver(to, emailChangeEmail[locale]({ link }), `email change → ${to}: ${link}`);
  }

  async sendPasswordChangedNotice(to: string, locale: Locale): Promise<void> {
    await this.deliver(to, passwordChangedEmail[locale]({}), `password-changed notice → ${to}`);
  }

  /**
   * Sends one email, or logs it when SMTP is off. Throws on a genuine SMTP
   * failure so flows that depend on delivery (verification, email change) can
   * surface it; best-effort callers (the password-changed notice) wrap this in
   * their own catch.
   */
  private async deliver(to: string, email: RenderedEmail, logLine: string): Promise<void> {
    if (!this.enabled) {
      this.logger.log(`[mail disabled] ${logLine}`);
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
