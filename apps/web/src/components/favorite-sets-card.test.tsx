// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FavoriteSet } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../messages/en.json';
import { FavoriteSetsCard } from './favorite-sets-card';

const text = messages.favoriteSets;
const PROFILE = '11111111-1111-4111-8111-111111111111';
const liked = (id: string, title: string) => ({ id: `mark-${id}`, sentiment: 'like', recipe: { id, title, mealTypes: ['breakfast'] } });
const aSet: FavoriteSet = { id: '22222222-2222-4222-8222-222222222222', profileId: PROFILE, label: 'Workday', slots: { breakfast: 'r-oats' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

/** The card of a profile with these marked recipes and these sets. */
async function renderCard(favorites: unknown[], sets: FavoriteSet[]) {
  vi.spyOn(api, 'get').mockImplementation((path: string) => Promise.resolve((path.startsWith('/favorite-sets') ? sets : favorites) as never));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FavoriteSetsCard profileId={PROFILE} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await screen.findByText(text.title);
}

describe('the card of a profile\'s favourite sets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says what a set is made from where the profile has marked no recipe, and leads to the recipes', async () => {
    await renderCard([], []);

    expect(await screen.findByText(text.noFavorites)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: text.noFavoritesCta })).toHaveAttribute('href', '/recipes');
    expect(screen.queryByRole('button', { name: text.newSet })).not.toBeInTheDocument();
  });

  it('says that there is no set yet and offers the first one, where there are recipes to make it from', async () => {
    await renderCard([liked('r-oats', 'Oat bowl')], []);

    expect(await screen.findByText(text.empty)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: text.newSet }));

    // The form to make it with takes the place of the sentence.
    expect(screen.getByLabelText(text.label)).toBeInTheDocument();
    expect(screen.queryByText(text.empty)).not.toBeInTheDocument();
  });

  it('lists the sets there are, with the button for another over them', async () => {
    await renderCard([liked('r-oats', 'Oat bowl')], [aSet]);

    expect(await screen.findByText('Workday')).toBeInTheDocument();
    expect(screen.getByText('Breakfast: Oat bowl')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: text.newSet })).toBeInTheDocument();
    expect(screen.queryByText(text.empty)).not.toBeInTheDocument();
  });

  it('says nothing is missing while the answers are on their way', async () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined));
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <FavoriteSetsCard profileId={PROFILE} />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    expect(await screen.findByText(text.title)).toBeInTheDocument();
    expect(screen.queryByText(text.noFavorites)).not.toBeInTheDocument();
    expect(screen.queryByText(text.empty)).not.toBeInTheDocument();
  });
});
