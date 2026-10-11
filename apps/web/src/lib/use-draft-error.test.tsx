// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { AdminApiError } from './admin-api';
import { ReviewApiError } from './review-api';
import { useDraftErrorText } from './use-draft-error';

function Shown({ error }: { error: unknown }) {
  const errorText = useDraftErrorText();
  return <p>{errorText(error, 'It did not work.')}</p>;
}

/** What somebody reading `locale` is told about `error`. */
function told(error: unknown, locale: 'en' | 'pl' = 'en'): string {
  const { unmount } = render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      <Shown error={error} />
    </NextIntlClientProvider>,
  );
  const text = screen.getByRole('paragraph').textContent ?? '';
  unmount();
  return text;
}

const refused = (problems: { path: string; rule: string }[]) =>
  new AdminApiError(400, 'The draft would break 3 rules: …', 'DRAFT_INVALID', undefined, { problems });

describe('what an editor is told when a draft edit is refused', () => {
  it('is every rule the edit broke, by the field it broke it in', () => {
    const error = refused([
      { path: 'titles.en', rule: 'markup' },
      { path: 'servings', rule: 'servings-out-of-range' },
      { path: 'steps.pl[2]', rule: 'text-too-long' },
      { path: 'ingredients[0].quantity', rule: 'quantity-too-large' },
    ]);

    expect(told(error)).toBe(
      'Not saved. Title (EN): may hold plain text only: no angle brackets and no hidden characters; Servings: must be a whole number from 1 to 12; Step 3 (PL): is longer than 300 characters; Ingredient 1: has more than one serving can hold',
    );
  });

  it('is the same in Polish', () => {
    const error = new ReviewApiError(400, 'DRAFT_INVALID', 'The draft would break a rule: …', undefined, {
      problems: [
        { path: 'titles.pl', rule: 'text-too-long' },
        { path: 'name.pl', rule: 'markup' },
      ],
    });

    expect(told(error, 'pl')).toBe('Nie zapisano. Tytuł (PL): ponad 120 znaków; Nazwa (PL): dozwolony jest tylko zwykły tekst: bez nawiasów ostrych i ukrytych znaków');
  });

  it('names a rule this version has no words for by its own name', () => {
    expect(told(refused([{ path: 'titles.en', rule: 'a-rule-of-tomorrow' }]))).toBe('Not saved. Title (EN): a-rule-of-tomorrow');
  });

  it('is the text of the refusal when it names no problem', () => {
    expect(told(refused([]))).toBe(en.errors.DRAFT_INVALID);
    expect(told(new ReviewApiError(409, 'DRAFT_REJECTED', 'This draft was rejected. Only the administrator can reopen it.'), 'pl')).toBe(pl.errors.DRAFT_REJECTED);
    expect(told(new AdminApiError(409, 'A draft that has shipped cannot be edited.', 'DRAFT_SHIPPED'), 'pl')).toBe(pl.errors.DRAFT_SHIPPED);
  });

  it('is what the API said when the code has no text here, and the fallback for anything else', () => {
    expect(told(new AdminApiError(500, 'Something the API said.', 'A_CODE_OF_TOMORROW'))).toBe('Something the API said.');
    expect(told('not an error')).toBe('It did not work.');
  });
});
