// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reviewApi } from '@/lib/review-api';
import messages from '../../../messages/en.json';
import { ReviewSurface } from './review-surface';

const text = messages.review;

/** The page of a reviewer who is signed in, on an instance that reviews Polish, with nothing waiting. */
async function renderSignedIn() {
  vi.spyOn(reviewApi, 'status').mockResolvedValue({ enabled: true, passwordSet: true, locales: ['pl'] });
  vi.spyOn(reviewApi, 'session').mockResolvedValue({ session: { label: 'Anna', issuedAt: '2026-10-12T08:00:00.000Z' } });
  vi.spyOn(reviewApi, 'listRecipeSlices').mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
  const names = vi.spyOn(reviewApi, 'listIngredientNameSlices').mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReviewSurface />
    </NextIntlClientProvider>,
  );
  await screen.findByText('Anna');
  return { names };
}

describe('the reviewer\'s page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says which language and which kind of draft is on show, to those who do not see the colour', async () => {
    const { names } = await renderSignedIn();

    expect(screen.getByRole('button', { name: text.locales.pl })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: text.kindRecipe })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: text.kindIngredientName })).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(screen.getByRole('button', { name: text.kindIngredientName }));

    expect(screen.getByRole('button', { name: text.kindIngredientName })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: text.kindRecipe })).toHaveAttribute('aria-pressed', 'false');
    await vi.waitFor(() => expect(names).toHaveBeenCalledWith('pl', { page: 1, pageSize: 25 }));
  });
});
