import type { Locale } from '@diet-app/shared';

/**
 * Transactional email copy, server-side and locale-keyed (`en` + `pl`).
 *
 * These are user-facing strings, so — like the curated `data/*.json` text —
 * every template ships both locales and the Polish must be reviewed by a
 * Polish-speaking maintainer before merge. They live here rather than in the
 * web `messages/*.json` because next-intl is a browser-only concern; the API
 * renders these at send time using the recipient's stored `locale`.
 *
 * Each builder returns a plain-text body and a minimal HTML body. We keep the
 * HTML deliberately tiny (a paragraph + a link) so it renders predictably
 * across clients and degrades gracefully to the text part.
 */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Wraps body paragraphs in a minimal, client-safe HTML shell. */
function shell(paragraphs: string[]): string {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px;line-height:1.5">${p}</p>`)
    .join('');
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1a1a1a;max-width:520px">${body}</div>`;
}

/** A standalone anchor used as a call-to-action button-ish link. */
function linkButton(href: string, label: string): string {
  return `<a href="${href}" style="color:#0a7d4b;font-weight:600">${label}</a>`;
}

type Builder<P> = Record<Locale, (params: P) => RenderedEmail>;

export const passwordResetEmail: Builder<{ link: string }> = {
  en: ({ link }) => ({
    subject: 'Reset your Diet App password',
    text: `Someone (hopefully you) asked to reset your Diet App password.\n\nOpen this link to choose a new password — it expires in 1 hour:\n${link}\n\nIf you didn't request this, you can safely ignore this email; your password stays unchanged.`,
    html: shell([
      'Someone (hopefully you) asked to reset your Diet App password.',
      `Choose a new password using the link below — it expires in 1 hour:`,
      linkButton(link, 'Reset password'),
      "If you didn't request this, you can safely ignore this email; your password stays unchanged.",
    ]),
  }),
  pl: ({ link }) => ({
    subject: 'Zresetuj hasło w Diet App',
    text: `Ktoś (mamy nadzieję, że Ty) poprosił o zresetowanie hasła w Diet App.\n\nOtwórz ten link, aby ustawić nowe hasło — wygasa po 1 godzinie:\n${link}\n\nJeśli to nie Ty, zignoruj tę wiadomość; hasło pozostanie bez zmian.`,
    html: shell([
      'Ktoś (mamy nadzieję, że Ty) poprosił o zresetowanie hasła w Diet App.',
      'Ustaw nowe hasło za pomocą poniższego linku — wygasa po 1 godzinie:',
      linkButton(link, 'Zresetuj hasło'),
      'Jeśli to nie Ty, zignoruj tę wiadomość; hasło pozostanie bez zmian.',
    ]),
  }),
};

export const emailVerificationEmail: Builder<{ link: string }> = {
  en: ({ link }) => ({
    subject: 'Confirm your Diet App email address',
    text: `Welcome to Diet App! Please confirm this email address to finish setting up your account.\n\nThis link expires in 1 hour:\n${link}\n\nIf you didn't create an account, you can ignore this email.`,
    html: shell([
      'Welcome to Diet App! Please confirm this email address to finish setting up your account.',
      'This link expires in 1 hour:',
      linkButton(link, 'Confirm email'),
      "If you didn't create an account, you can ignore this email.",
    ]),
  }),
  pl: ({ link }) => ({
    subject: 'Potwierdź swój adres e-mail w Diet App',
    text: `Witamy w Diet App! Potwierdź ten adres e-mail, aby dokończyć konfigurację konta.\n\nLink wygasa po 1 godzinie:\n${link}\n\nJeśli nie zakładałeś konta, zignoruj tę wiadomość.`,
    html: shell([
      'Witamy w Diet App! Potwierdź ten adres e-mail, aby dokończyć konfigurację konta.',
      'Link wygasa po 1 godzinie:',
      linkButton(link, 'Potwierdź e-mail'),
      'Jeśli nie zakładałeś konta, zignoruj tę wiadomość.',
    ]),
  }),
};

export const emailChangeEmail: Builder<{ link: string }> = {
  en: ({ link }) => ({
    subject: 'Confirm your new Diet App email address',
    text: `You asked to change your Diet App email to this address. Confirm the change to start using it for sign-in.\n\nThis link expires in 1 hour:\n${link}\n\nIf you didn't request this, you can ignore this email — your account email stays unchanged.`,
    html: shell([
      'You asked to change your Diet App email to this address. Confirm the change to start using it for sign-in.',
      'This link expires in 1 hour:',
      linkButton(link, 'Confirm new email'),
      "If you didn't request this, you can ignore this email — your account email stays unchanged.",
    ]),
  }),
  pl: ({ link }) => ({
    subject: 'Potwierdź nowy adres e-mail w Diet App',
    text: `Poprosiłeś o zmianę adresu e-mail w Diet App na ten adres. Potwierdź zmianę, aby zacząć logować się przy jego użyciu.\n\nLink wygasa po 1 godzinie:\n${link}\n\nJeśli to nie Ty, zignoruj tę wiadomość — adres konta pozostanie bez zmian.`,
    html: shell([
      'Poprosiłeś o zmianę adresu e-mail w Diet App na ten adres. Potwierdź zmianę, aby zacząć logować się przy jego użyciu.',
      'Link wygasa po 1 godzinie:',
      linkButton(link, 'Potwierdź nowy e-mail'),
      'Jeśli to nie Ty, zignoruj tę wiadomość — adres konta pozostanie bez zmian.',
    ]),
  }),
};

export const passwordChangedEmail: Builder<Record<string, never>> = {
  en: () => ({
    subject: 'Your Diet App password was changed',
    text: 'This is a confirmation that your Diet App password was just changed. All other sessions have been signed out.\n\nIf this wasn\'t you, reset your password immediately from the sign-in page and contact your instance operator.',
    html: shell([
      'This is a confirmation that your Diet App password was just changed. All other sessions have been signed out.',
      "If this wasn't you, reset your password immediately from the sign-in page and contact your instance operator.",
    ]),
  }),
  pl: () => ({
    subject: 'Hasło w Diet App zostało zmienione',
    text: 'To potwierdzenie, że hasło w Diet App zostało właśnie zmienione. Wszystkie pozostałe sesje zostały wylogowane.\n\nJeśli to nie Ty, natychmiast zresetuj hasło na stronie logowania i skontaktuj się z operatorem instancji.',
    html: shell([
      'To potwierdzenie, że hasło w Diet App zostało właśnie zmienione. Wszystkie pozostałe sesje zostały wylogowane.',
      'Jeśli to nie Ty, natychmiast zresetuj hasło na stronie logowania i skontaktuj się z operatorem instancji.',
    ]),
  }),
};
