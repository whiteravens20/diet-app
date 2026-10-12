// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { ApiClientError } from './http';
import { useErrorText } from './use-error-text';

function Shown({ error, fallback }: { error: unknown; fallback?: string }) {
  const errorText = useErrorText();
  return <p>{errorText(error, fallback)}</p>;
}

/** What somebody reading `locale` is told about `error`. */
function told(error: unknown, { locale = 'en', fallback }: { locale?: 'en' | 'pl'; fallback?: string } = {}): string {
  const { unmount } = render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      <Shown error={error} fallback={fallback} />
    </NextIntlClientProvider>,
  );
  const text = screen.getByRole('paragraph').textContent ?? '';
  unmount();
  return text;
}

describe('what anybody is told when a request failed', () => {
  it('is what the code of the refusal stands for, in the language they read', () => {
    const full = new ApiClientError(409, 'PANTRY_FULL', 'A pantry holds at most 1000 rows. Remove one to add another.');

    expect(told(full)).toBe(en.errors.PANTRY_FULL);
    expect(told(full, { locale: 'pl' })).toBe(pl.errors.PANTRY_FULL);
    // The sentence a screen has for "it did not work" is not needed when the refusal says why.
    expect(told(full, { locale: 'pl', fallback: 'Nie udało się dodać.' })).toBe(pl.errors.PANTRY_FULL);
  });

  it('is for how long to wait, when the server held the request up and said so', () => {
    const held = (seconds: number | undefined) => new ApiClientError(429, 'TOO_MANY_ATTEMPTS', 'Too many.', undefined, seconds);

    expect(told(held(240))).toBe('Too many attempts. Try again in 4 minutes.');
    expect(told(held(30))).toBe('Too many attempts. Try again in 30 seconds.');
    expect(told(held(60), { locale: 'pl' })).toContain('60 sekund');
    // A refusal for too many requests that names no wait says what its code says.
    expect(told(held(undefined))).toBe(en.errors.TOO_MANY_ATTEMPTS);
  });

  it('names the fields a refused form got wrong', () => {
    const refused = new ApiClientError(400, 'VALIDATION_FAILED', 'Request payload failed validation.', [
      { path: 'weightKg', message: 'Too big: expected number to be <=400' },
      { path: 'name', message: 'Too small' },
      { path: 'weightKg', message: 'Invalid input' },
    ]);

    expect(told(refused)).toBe('Some fields need attention: weightKg, name.');
    expect(told(refused, { locale: 'pl' })).toBe('Niektóre pola wymagają poprawy: weightKg, name.');
    expect(told(new ApiClientError(400, 'VALIDATION_FAILED', 'Request payload failed validation.'))).toBe(en.errors.VALIDATION_FAILED);
  });

  it('is what the API said for a code this version has no words for', () => {
    expect(told(new ApiClientError(409, 'A_CODE_OF_TOMORROW', 'Something the API said.'), { locale: 'pl', fallback: 'Nie udało się.' })).toBe('Something the API said.');
  });

  it('is the sentence of the screen, or the general one, where nothing can be said about why', () => {
    const noAnswer = new ApiClientError(502, 'ERROR', 'Bad Gateway');

    expect(told(noAnswer, { fallback: 'Could not save.' })).toBe('Could not save.');
    expect(told(noAnswer)).toBe(en.errors.GENERIC);
    expect(told(new Error('a bug of the page'), { fallback: 'Could not save.' })).toBe('Could not save.');
    expect(told('not even an error', { locale: 'pl' })).toBe(pl.errors.GENERIC);
  });

  it('says that the server cannot be reached when nothing answered', () => {
    expect(told(new ApiClientError(0, 'NETWORK', 'Cannot reach the server.'), { locale: 'pl', fallback: 'Nie udało się.' })).toBe(pl.errors.NETWORK);
  });
});
