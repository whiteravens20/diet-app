// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { ApiClientError } from './http';
import { useDraftErrorText, useSkipReasonText } from './use-draft-error';

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
  new ApiClientError(400, 'DRAFT_INVALID', 'The draft would break 3 rules: …', undefined, undefined, { problems });

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
    const error = new ApiClientError(400, 'DRAFT_INVALID', 'The draft would break a rule: …', undefined, undefined, {
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
    expect(told(new ApiClientError(409, 'DRAFT_REJECTED', 'This draft was rejected. Only the administrator can reopen it.'), 'pl')).toBe(pl.errors.DRAFT_REJECTED);
    expect(told(new ApiClientError(409, 'DRAFT_SHIPPED', 'A draft that has shipped cannot be edited.'), 'pl')).toBe(pl.errors.DRAFT_SHIPPED);
  });

  it('is what the API said when the code has no text here, and the fallback for anything else', () => {
    expect(told(new ApiClientError(500, 'A_CODE_OF_TOMORROW', 'Something the API said.'))).toBe('Something the API said.');
    expect(told('not an error')).toBe('It did not work.');
  });
});

function Reason({ reason }: { reason: string }) {
  const reasonText = useSkipReasonText();
  return <p>{reasonText(reason)}</p>;
}

/** What somebody reading `locale` is told about a draft that did not ship for `reason`. */
function heldBack(reason: string, locale: 'en' | 'pl' = 'en'): string {
  const { unmount } = render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      <Reason reason={reason} />
    </NextIntlClientProvider>,
  );
  const text = screen.getByRole('paragraph').textContent ?? '';
  unmount();
  return text;
}

describe('what the administrator is told about a draft that did not ship', () => {
  it('is the rule in words, with what it is about', () => {
    expect(heldBack('slug-taken: milk-porridge')).toBe('another recipe already has the slug milk-porridge; change the slug of the draft');
    expect(heldBack('title-taken: Oat bowl')).toBe('another recipe of the library is already called “Oat bowl”');
    expect(heldBack('same-making-as: milk-porridge')).toBe('has the same ingredients, amounts, meals and servings as milk-porridge');
    expect(heldBack('facts-moved-since-review: calories 100 → 412; allergens +gluten')).toBe(
      'its figures changed since it was reviewed (calories 100 → 412; allergens +gluten); save it again and have it approved',
    );
    expect(heldBack('not-approved: PENDING')).toBe('is not approved any more');
    expect(heldBack('changed-while-shipping')).toBe('changed while it was being shipped; the pull request holds it as it was');
  });

  it('names each rule a draft breaks by its field, as a refused edit does', () => {
    expect(heldBack('invalid-draft: titles.en: markup; servings: servings-out-of-range')).toBe(
      'breaks a rule for recipes (Title (EN): may hold plain text only: no angle brackets and no hidden characters; Servings: must be a whole number from 1 to 12)',
    );
  });

  it('is said in Polish to a Polish reader', () => {
    expect(heldBack('slug-taken: milk-porridge', 'pl')).toBe('slug milk-porridge ma już inny przepis; zmień slug szkicu');
    expect(heldBack('draft-gone', 'pl')).toBe('został w międzyczasie usunięty');
  });

  it('is the reason as the API wrote it when this version has no words for the rule', () => {
    expect(heldBack('a-rule-of-tomorrow: something')).toBe('a-rule-of-tomorrow: something');
  });

  it('is what a refused promotion says too', () => {
    const error = new ApiClientError(409, 'DRAFT_NOT_SHIPPABLE', 'The draft cannot go into the library: same-making-as: milk-porridge.', undefined, undefined, {
      reason: 'same-making-as: milk-porridge',
    });

    expect(told(error)).toBe('This draft cannot go into the library as it is: has the same ingredients, amounts, meals and servings as milk-porridge');
  });
});
