// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecipeReviewSlice } from '@diet-app/shared';
import { ApiClientError } from '@/lib/http';
import { reviewApi } from '@/lib/review-api';
import messages from '../../../messages/en.json';
import polish from '../../../messages/pl.json';
import { ReviewQueue } from './review-queue';

const text = messages.review;

const recipe = (id: string, title: string, over: Partial<RecipeReviewSlice> = {}): RecipeReviewSlice => ({
  id,
  slug: title.toLowerCase().replaceAll(' ', '-'),
  locale: 'pl',
  title,
  titleSource: `${title} (English)`,
  description: 'Opis.',
  descriptionSource: 'A description.',
  steps: ['Ugotuj.', 'Podaj.'],
  stepsSource: ['Cook.', 'Serve.'],
  servings: 2,
  mealTypes: ['breakfast'],
  dietTags: ['balanced'],
  prepMinutes: 5,
  cookMinutes: 10,
  difficulty: 'easy',
  complexity: 'simple',
  caloriesPerServing: 420,
  proteinPerServing: 20,
  fatPerServing: 12,
  carbsPerServing: 55,
  allergens: [],
  ingredients: [],
  batchId: 'batch-1',
  modelUsed: null,
  status: 'PENDING',
  alreadyReviewed: false,
  alreadyReviewedAction: null,
  ...over,
});

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

/** The queue of Polish recipe drafts with `items` waiting. */
async function renderQueue(items: RecipeReviewSlice[], locale: 'en' | 'pl' = 'en') {
  vi.spyOn(reviewApi, 'listRecipeSlices').mockResolvedValue({ items, total: items.length, page: 1, pageSize: 25 });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? messages : polish}>
      <ReviewQueue locale="pl" kind="recipe" />
    </NextIntlClientProvider>,
  );
  await screen.findByRole('button', { name: (locale === 'en' ? messages : polish).review.approve });
}

const button = (name: string) => screen.getByRole('button', { name });

describe('the reviewer\'s queue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not approve text it could not save: the draft stays, with what was typed', async () => {
    const patch = vi.spyOn(reviewApi, 'patchRecipeSlice').mockRejectedValue(new ApiClientError(503, 'UNAVAILABLE', 'down'));
    const approve = vi.spyOn(reviewApi, 'approveRecipe');
    await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);

    await userEvent.type(screen.getByRole('textbox', { name: text.fieldTitle }), ' z jabłkiem');
    await userEvent.click(button(text.approve));

    await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button(text.approve)).toBeEnabled());
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: text.fieldTitle })).toHaveValue('Owsianka z jabłkiem');
  });

  it('approves what was typed once it is saved', async () => {
    const patch = vi.spyOn(reviewApi, 'patchRecipeSlice').mockResolvedValue(recipe(FIRST, 'Owsianka z jabłkiem'));
    const approve = vi.spyOn(reviewApi, 'approveRecipe').mockResolvedValue(recipe(FIRST, 'Owsianka z jabłkiem'));
    await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);

    await userEvent.type(screen.getByRole('textbox', { name: text.fieldTitle }), ' z jabłkiem');
    await userEvent.click(button(text.approve));

    await vi.waitFor(() => expect(approve).toHaveBeenCalledExactlyOnceWith('pl', FIRST));
    expect(patch).toHaveBeenCalledExactlyOnceWith('pl', FIRST, { title: 'Owsianka z jabłkiem', description: undefined, steps: undefined });
    expect(await screen.findByDisplayValue('Jajecznica')).toBeInTheDocument();
  });

  it('has nothing left to save once the text was saved', async () => {
    const patch = vi.spyOn(reviewApi, 'patchRecipeSlice').mockResolvedValue(recipe(FIRST, 'Owsianka z jabłkiem'));
    await renderQueue([recipe(FIRST, 'Owsianka')]);
    expect(button(text.save)).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox', { name: text.fieldTitle }), ' z jabłkiem');
    await userEvent.click(button(text.save));

    await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button(text.save)).toBeDisabled());
  });

  it('reads the next page when the last draft of one is decided, and says nothing is left only when nothing is', async () => {
    vi.spyOn(reviewApi, 'approveRecipe').mockResolvedValue(recipe(FIRST, 'Owsianka'));
    const list = vi.spyOn(reviewApi, 'listRecipeSlices');
    let answer: (page: { items: RecipeReviewSlice[]; total: number; page: number; pageSize: number }) => void = () => undefined;
    list.mockResolvedValueOnce({ items: [recipe(FIRST, 'Owsianka')], total: 2, page: 1, pageSize: 25 });
    list.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReviewQueue locale="pl" kind="recipe" />
      </NextIntlClientProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: text.approve }));

    // The next page is on its way: the queue is not said to be empty meanwhile.
    expect(await screen.findByText(text.queueLoading)).toBeInTheDocument();
    expect(screen.queryByText(text.queueEmpty)).not.toBeInTheDocument();
    answer({ items: [recipe(SECOND, 'Jajecznica')], total: 1, page: 1, pageSize: 25 });
    expect(await screen.findByDisplayValue('Jajecznica')).toBeInTheDocument();
  });

  it('says nothing is left once the last page is done', async () => {
    vi.spyOn(reviewApi, 'approveRecipe').mockResolvedValue(recipe(FIRST, 'Owsianka'));
    const list = vi.spyOn(reviewApi, 'listRecipeSlices');
    list.mockResolvedValueOnce({ items: [recipe(FIRST, 'Owsianka')], total: 1, page: 1, pageSize: 25 });
    list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReviewQueue locale="pl" kind="recipe" />
      </NextIntlClientProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: text.approve }));

    expect(await screen.findByText(text.queueEmpty)).toBeInTheDocument();
  });
});
