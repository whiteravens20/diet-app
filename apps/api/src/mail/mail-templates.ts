// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

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
    text: 'This is a confirmation that your Diet App password was just changed. Every session of the account was signed out: sign in again with the new password.\n\nIf this wasn\'t you, reset your password immediately from the sign-in page and contact your instance operator.',
    html: shell([
      'This is a confirmation that your Diet App password was just changed. Every session of the account was signed out: sign in again with the new password.',
      "If this wasn't you, reset your password immediately from the sign-in page and contact your instance operator.",
    ]),
  }),
  pl: () => ({
    subject: 'Hasło w Diet App zostało zmienione',
    text: 'To potwierdzenie, że hasło w Diet App zostało właśnie zmienione. Wszystkie sesje konta zostały wylogowane: zaloguj się ponownie nowym hasłem.\n\nJeśli to nie Ty, natychmiast zresetuj hasło na stronie logowania i skontaktuj się z operatorem instancji.',
    html: shell([
      'To potwierdzenie, że hasło w Diet App zostało właśnie zmienione. Wszystkie sesje konta zostały wylogowane: zaloguj się ponownie nowym hasłem.',
      'Jeśli to nie Ty, natychmiast zresetuj hasło na stronie logowania i skontaktuj się z operatorem instancji.',
    ]),
  }),
};

/**
 * Enough of an address to know it by, for a notice that goes to another
 * address: the first character and the domain. Whoever reads the old mailbox
 * of an account need not learn where the account moved to.
 */
export function partOf(address: string): string {
  const at = address.lastIndexOf('@');
  return `${address.slice(0, 1)}•••${address.slice(at)}`;
}

/** To the address an account has, when a change to another one was asked for. `newAddress` is shown in part. */
export const emailChangeRequestedEmail: Builder<{ newAddress: string }> = {
  en: ({ newAddress }) => ({
    subject: 'A change of your Diet App email address was requested',
    text: `Someone signed in to your Diet App account asked to change its email address to ${partOf(newAddress)}. The address changes only when the link sent to that address is followed.\n\nIf this was you, there is nothing to do here. If it wasn't, change your password now: that also cancels the request.`,
    html: shell([
      `Someone signed in to your Diet App account asked to change its email address to ${partOf(newAddress)}. The address changes only when the link sent to that address is followed.`,
      "If this was you, there is nothing to do here. If it wasn't, change your password now: that also cancels the request.",
    ]),
  }),
  pl: ({ newAddress }) => ({
    subject: 'Poproszono o zmianę adresu e-mail w Diet App',
    text: `Ktoś zalogowany na Twoje konto w Diet App poprosił o zmianę adresu e-mail na ${partOf(newAddress)}. Adres zmieni się dopiero po otwarciu linku wysłanego na ten adres.\n\nJeśli to Ty, nie musisz nic robić. Jeśli nie, zmień teraz hasło: to także anuluje tę prośbę.`,
    html: shell([
      `Ktoś zalogowany na Twoje konto w Diet App poprosił o zmianę adresu e-mail na ${partOf(newAddress)}. Adres zmieni się dopiero po otwarciu linku wysłanego na ten adres.`,
      'Jeśli to Ty, nie musisz nic robić. Jeśli nie, zmień teraz hasło: to także anuluje tę prośbę.',
    ]),
  }),
};

/** To the address an account had, once it has another. `newAddress` is shown in part. */
export const emailChangedEmail: Builder<{ newAddress: string }> = {
  en: ({ newAddress }) => ({
    subject: 'Your Diet App email address was changed',
    text: `The email address of your Diet App account was changed to ${partOf(newAddress)}. This address no longer signs in, and every session was signed out.\n\nIf this wasn't you, contact your instance operator.`,
    html: shell([
      `The email address of your Diet App account was changed to ${partOf(newAddress)}. This address no longer signs in, and every session was signed out.`,
      "If this wasn't you, contact your instance operator.",
    ]),
  }),
  pl: ({ newAddress }) => ({
    subject: 'Adres e-mail w Diet App został zmieniony',
    text: `Adres e-mail Twojego konta w Diet App został zmieniony na ${partOf(newAddress)}. Tym adresem nie można się już zalogować, a wszystkie sesje zostały wylogowane.\n\nJeśli to nie Ty, skontaktuj się z operatorem instancji.`,
    html: shell([
      `Adres e-mail Twojego konta w Diet App został zmieniony na ${partOf(newAddress)}. Tym adresem nie można się już zalogować, a wszystkie sesje zostały wylogowane.`,
      'Jeśli to nie Ty, skontaktuj się z operatorem instancji.',
    ]),
  }),
};

/** Two paragraphs, as text and as HTML. */
function notice(subject: string, first: string, second: string): RenderedEmail {
  return { subject, text: `${first}\n\n${second}`, html: shell([first, second]) };
}

/** To an account that now signs in with a code from an authenticator app as well. */
export const secondFactorOnEmail: Builder<Record<string, never>> = {
  en: () =>
    notice(
      'Two-step sign-in was switched on for your Diet App account',
      'Two-step sign-in was just switched on for your Diet App account: signing in now takes your password and a code from your authenticator app. Every other session was signed out.',
      "If this wasn't you, contact your instance operator: somebody who knows your password has set it up with an app of their own.",
    ),
  pl: () =>
    notice(
      'Logowanie dwuetapowe w Diet App zostało włączone',
      'Na Twoim koncie w Diet App właśnie włączono logowanie dwuetapowe: do zalogowania potrzebne jest teraz hasło i kod z aplikacji uwierzytelniającej. Wszystkie pozostałe sesje zostały wylogowane.',
      'Jeśli to nie Ty, skontaktuj się z operatorem instancji: ktoś, kto zna Twoje hasło, podłączył własną aplikację.',
    ),
};

/** To an account that signs in with its password alone again. `by` says who switched the second step off. */
export const secondFactorOffEmail: Builder<{ by: 'holder' | 'operator' }> = {
  en: ({ by }) =>
    by === 'holder'
      ? notice(
          'Two-step sign-in was switched off for your Diet App account',
          'Two-step sign-in was just switched off for your Diet App account: signing in takes only your password again.',
          "If this wasn't you, change your password now and switch two-step sign-in on again.",
        )
      : notice(
          'Two-step sign-in was switched off for your Diet App account',
          'The operator of your instance switched two-step sign-in off for your Diet App account: signing in takes only your password again.',
          'If you did not ask for this, change your password now, switch two-step sign-in on again and contact your instance operator.',
        ),
  pl: ({ by }) =>
    by === 'holder'
      ? notice(
          'Logowanie dwuetapowe w Diet App zostało wyłączone',
          'Na Twoim koncie w Diet App właśnie wyłączono logowanie dwuetapowe: do zalogowania znów wystarcza samo hasło.',
          'Jeśli to nie Ty, zmień teraz hasło i włącz logowanie dwuetapowe ponownie.',
        )
      : notice(
          'Logowanie dwuetapowe w Diet App zostało wyłączone',
          'Operator instancji wyłączył logowanie dwuetapowe na Twoim koncie w Diet App: do zalogowania znów wystarcza samo hasło.',
          'Jeśli to nie na Twoją prośbę, zmień teraz hasło, włącz logowanie dwuetapowe ponownie i skontaktuj się z operatorem instancji.',
        ),
};

/** To an account one of whose recovery codes was used. `left` is how many it still has. */
export const recoveryCodeUsedEmail: Builder<{ left: number }> = {
  en: ({ left }) =>
    notice(
      'A recovery code of your Diet App account was used',
      `A recovery code was just used in the place of a code from your authenticator app. Recovery codes left: ${left}.`,
      "If this wasn't you, change your password now and make new recovery codes in the settings.",
    ),
  pl: ({ left }) =>
    notice(
      'Użyto kodu zapasowego Twojego konta w Diet App',
      `Właśnie użyto kodu zapasowego zamiast kodu z aplikacji uwierzytelniającej. Pozostałe kody zapasowe: ${left}.`,
      'Jeśli to nie Ty, zmień teraz hasło i wygeneruj nowe kody zapasowe w ustawieniach.',
    ),
};

/** To an account whose password was right and whose code was then wrong so often that codes have to wait. */
export const secondFactorFailedEmail: Builder<Record<string, never>> = {
  en: () =>
    notice(
      'Wrong sign-in codes were entered for your Diet App account',
      'Someone entered the password of your Diet App account and then got the code of the second step wrong five times in a row. A code now has to wait before it is looked at.',
      "If this was you, there is nothing to do: wait, or use a recovery code. If it wasn't, somebody knows your password: change it now.",
    ),
  pl: () =>
    notice(
      'Błędne kody logowania do Twojego konta w Diet App',
      'Ktoś podał hasło do Twojego konta w Diet App, a potem pięć razy z rzędu wpisał błędny kod drugiego etapu. Przed kolejną próbą trzeba teraz odczekać.',
      'Jeśli to Ty, nie musisz nic robić: odczekaj albo użyj kodu zapasowego. Jeśli nie, ktoś zna Twoje hasło: zmień je teraz.',
    ),
};
