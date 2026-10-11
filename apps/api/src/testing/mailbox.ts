// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Transporter } from 'nodemailer';
import { MailService } from '../mail/mail.service.js';
import type { TestApp } from './test-app.js';

export interface SentMail {
  to: string;
  subject: string;
  text: string;
}

/** The settings that make the application send mail: a test file that reads mail starts it with these. */
export const MAIL_ON = { SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'Diet App <no-reply@example.test>' };

/**
 * Everything the application sends from now on, instead of a mail server:
 * nothing leaves the process. The application must run with `MAIL_ON`.
 */
export function aMailbox(t: TestApp): {
  sent: SentMail[];
  /** Wait until everything the application handed over has gone out or failed. */
  settled(): Promise<void>;
  /** The mails sent to `address`, oldest first, once everything handed over has gone out. */
  to(address: string): Promise<SentMail[]>;
  /** The token of the link in the last mail sent to `address`. */
  tokenFor(address: string): Promise<string>;
  /** A transport that fails every send, as a mail server that is down would. */
  failing(): void;
  /** A transport that takes mail and keeps it until the function returned is called. */
  holding(): () => void;
  working(): void;
} {
  const sent: SentMail[] = [];
  const mail = t.app.get(MailService);
  const working = { sendMail: async (message: SentMail) => void sent.push({ to: message.to, subject: message.subject, text: message.text }) };
  const failing = { sendMail: () => Promise.reject(new Error('connect ECONNREFUSED smtp.example.test:587')) };
  mail.transport = working as unknown as Transporter;
  const to = async (address: string): Promise<SentMail[]> => {
    await mail.idle();
    return sent.filter((message) => message.to === address);
  };
  return {
    sent,
    settled: () => mail.idle(),
    to,
    async tokenFor(address) {
      const last = (await to(address)).at(-1);
      const token = last && /[?&]token=([0-9a-f]+)/.exec(last.text)?.[1];
      if (!token) throw new Error(`no mail with a link was sent to ${address}`);
      return token;
    },
    failing: () => void (mail.transport = failing as unknown as Transporter),
    holding() {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      mail.transport = { sendMail: async (message: SentMail) => held.then(() => working.sendMail(message)) } as unknown as Transporter;
      return () => {
        release();
        mail.transport = working as unknown as Transporter;
      };
    },
    working: () => void (mail.transport = working as unknown as Transporter),
  };
}
