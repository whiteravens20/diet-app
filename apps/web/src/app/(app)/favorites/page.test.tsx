// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNDO_FOR_MS } from '@/components/removed-later';
import type { MarkedRecipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { aPublicConfig } from '@/testing/public-config';
import { failReadsAgain } from '@/testing/read-again';
import messages from '../../../../messages/en.json';
import FavoritesPage from './page';

const texts = messages.favorites;
const PROFILE = '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f';

const aMark = (title: string, over: Partial<MarkedRecipe> = {}): MarkedRecipe =>
  ({
    id: `mark-${title}`,
    tags: [],
    sentiment: 'favorite',
    markedAt: '2026-01-05T10:00:00.000Z',
    recipe: {
      id: `recipe-${title}`,
      title,
      mealTypes: ['lunch', 'dinner'],
      nutritionPerServing: { calories: 520, protein: 30, fat: 12, carbs: 60 },
    },
    ...over,
  }) as MarkedRecipe;

/** What the page asked the list for, last, beyond the profile. */
let asked: Record<string, string> = {};

/** The page of an account with `profiles`, one by default, each of which marked `marks`. */
async function renderPage(marks: MarkedRecipe[], profiles = [{ id: PROFILE, name: 'Me' }]) {
  vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path.startsWith('/favorites?')) {
      const query = Object.fromEntries(new URLSearchParams(path.slice('/favorites?'.length)));
      if (Object.keys(query).length > 1) asked = query;
      return Promise.resolve(marks as never);
    }
    return Promise.resolve((path === '/profiles' ? profiles : []) as never);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig());
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <FavoritesPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await screen.findByRole('heading', { name: texts.title });
  return client;
}

describe('the recipes a profile marked, on a page of their own', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    asked = {};
  });

  const stew = aMark('Chickpea stew', { sentiment: 'often', tags: ['quick', 'work'] });
  const porridge = aMark('Milk porridge', { tags: ['quick'] });

  it('lists each with how it is marked, its tags and what a serving holds', async () => {
    await renderPage([stew, porridge]);

    expect(await screen.findByText('2 recipes')).toBeInTheDocument();
    expect(screen.getByLabelText('How Chickpea stew is marked')).toHaveValue('often');
    expect(screen.getByLabelText('How Milk porridge is marked')).toHaveValue('favorite');
    expect(
      within(screen.getByRole('list', { name: 'Tags of Chickpea stew' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['quick×', 'work×']);
    expect(screen.getAllByText('520 kcal a serving · Lunch and Dinner')).toHaveLength(2);
    // What the marks mean is said on the page.
    expect(screen.getByText(texts.legend)).toBeInTheDocument();
  });

  it('offers the tags of the profile to narrow by, and asks the API for what was chosen', async () => {
    await renderPage([stew, porridge]);
    await screen.findByText('2 recipes');

    expect(
      within(screen.getByLabelText(texts.tag))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Any', 'quick', 'work']);
    await userEvent.selectOptions(screen.getByLabelText(texts.tag), 'work');
    await userEvent.selectOptions(screen.getByLabelText(texts.marked), 'often');
    await userEvent.selectOptions(screen.getByLabelText(texts.sort), 'calories');

    await vi.waitFor(() =>
      expect(asked).toEqual({
        profileId: PROFILE,
        tag: 'work',
        sentiment: 'often',
        sort: 'calories',
      }),
    );
  });

  it('marks a recipe another way where it is shown, at once, and keeps its tags', async () => {
    await renderPage([stew, porridge]);
    await screen.findByText('2 recipes');
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never);

    await userEvent.selectOptions(screen.getByLabelText('How Chickpea stew is marked'), 'avoid');

    expect(post).toHaveBeenCalledWith('/favorites', {
      profileId: PROFILE,
      recipeId: stew.recipe.id,
      sentiment: 'avoid',
      tags: ['quick', 'work'],
    });
  });

  it('puts a tag on a recipe and takes one off, and puts none on twice', async () => {
    await renderPage([porridge]);
    await screen.findByText('1 recipe');
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never);
    const newTag = screen.getByLabelText('A new tag for Milk porridge');

    await userEvent.type(newTag, ' weekend {Enter}');
    expect(post).toHaveBeenLastCalledWith('/favorites', {
      profileId: PROFILE,
      recipeId: porridge.recipe.id,
      sentiment: 'favorite',
      tags: ['quick', 'weekend'],
    });

    await vi.waitFor(() => expect(newTag).toBeEnabled());
    await userEvent.type(newTag, 'quick{Enter}');
    expect(post).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Remove the tag quick' }));
    expect(post).toHaveBeenLastCalledWith('/favorites', {
      profileId: PROFILE,
      recipeId: porridge.recipe.id,
      sentiment: 'favorite',
      tags: [],
    });
  });

  it('takes the mark off a recipe at once, says so with a way to take it back, and sends it after', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    await renderPage([stew, porridge]);
    await screen.findByText('2 recipes');
    const remove = vi.spyOn(api, 'request').mockResolvedValue(undefined as never);

    await userEvent.click(screen.getByRole('button', { name: 'Remove the mark of Milk porridge' }));

    expect(screen.queryByText('Milk porridge')).toBeNull();
    expect(screen.getByText('Removed: Milk porridge.')).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(UNDO_FOR_MS));
    expect(remove).toHaveBeenCalledWith(`/favorites/${PROFILE}/${porridge.recipe.id}`, {
      method: 'DELETE',
      keepalive: true,
    });
    vi.useRealTimers();
  });

  it('keeps a mark taken back, and sends nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    await renderPage([stew, porridge]);
    await screen.findByText('2 recipes');
    const remove = vi.spyOn(api, 'request').mockResolvedValue(undefined as never);

    await userEvent.click(screen.getByRole('button', { name: 'Remove the mark of Milk porridge' }));
    await userEvent.click(screen.getByRole('button', { name: messages.common.undo }));

    expect(screen.getByText('2 recipes')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(UNDO_FOR_MS * 2));
    expect(remove).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('takes a change back and says so when the API refuses it', async () => {
    await renderPage([stew]);
    await screen.findByText('1 recipe');
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiClientError(409, 'WRITE_CONFLICT', 'the text of the API'),
    );

    await userEvent.selectOptions(screen.getByLabelText('How Chickpea stew is marked'), 'avoid');

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.WRITE_CONFLICT);
    expect(screen.getByLabelText('How Chickpea stew is marked')).toHaveValue('often');
  });

  it('takes a mark off for the profile it was taken off for, whichever is chosen when it is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    await renderPage(
      [stew, porridge],
      [
        { id: PROFILE, name: 'Me' },
        { id: 'other-profile', name: 'You' },
      ],
    );
    await screen.findByText('2 recipes');
    const remove = vi.spyOn(api, 'request').mockResolvedValue(undefined as never);

    await userEvent.click(screen.getByRole('button', { name: 'Remove the mark of Milk porridge' }));
    await userEvent.click(screen.getByRole('button', { name: 'You' }));
    await act(() => vi.advanceTimersByTimeAsync(UNDO_FOR_MS));

    expect(remove).toHaveBeenCalledExactlyOnceWith(`/favorites/${PROFILE}/${porridge.recipe.id}`, {
      method: 'DELETE',
      keepalive: true,
    });
    vi.useRealTimers();
  });

  it('says where to mark a recipe while nothing is marked, and asks for no filter of nothing', async () => {
    await renderPage([]);

    expect(await screen.findByText(texts.emptyTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.emptyCta })).toHaveAttribute('href', '/recipes');
    expect(screen.queryByLabelText(texts.search)).toBeNull();
  });

  it('says that nothing matches while a filter finds nothing', async () => {
    await renderPage([aMark('Chickpea stew')]);
    const answers = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path: string) =>
      path.startsWith('/favorites?') && path.includes('search=')
        ? Promise.resolve([] as never)
        : answers(path),
    );

    await userEvent.type(await screen.findByLabelText(texts.search), 'soup');

    expect(await screen.findByText(texts.noneFiltered)).toBeInTheDocument();
    expect(screen.queryByText(texts.emptyTitle)).toBeNull();
  });
});

describe('the marked recipes read again', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    asked = {};
  });

  it('keeps the recipes it showed when a read fails again, says why above them, and reads again when asked', async () => {
    const client = await renderPage([aMark('Chickpea stew', { sentiment: 'often' })]);
    expect(await screen.findByText('Chickpea stew')).toBeInTheDocument();

    const answerAgain = await failReadsAgain(client);

    const note = await screen.findByText(messages.common.shownFromBefore, { exact: false });
    expect(note.closest('[role="alert"]')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.getByText('Chickpea stew')).toBeInTheDocument();
    answerAgain();
    await userEvent.click(
      within(note.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: messages.common.retry,
      }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByText(messages.common.shownFromBefore, { exact: false })).toBeNull(),
    );
    expect(screen.getByText('Chickpea stew')).toBeInTheDocument();
  });
});
