// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngredientNameReviewSlice, RecipeReviewSlice } from '@diet-app/shared';
import { ApiClientError } from '@/lib/http';
import { reviewApi } from '@/lib/review-api';
import messages from '../../../messages/en.json';
import polish from '../../../messages/pl.json';
import { ReviewQueue } from './review-queue';

const text = messages.review;

const recipe = (
  id: string,
  title: string,
  over: Partial<RecipeReviewSlice> = {},
): RecipeReviewSlice => ({
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
const THIRD = '33333333-3333-4333-8333-333333333333';

/** The queue of Polish recipe drafts with `items` waiting. */
async function renderQueue(items: RecipeReviewSlice[], locale: 'en' | 'pl' = 'en') {
  vi.spyOn(reviewApi, 'listRecipeSlices').mockResolvedValue({
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
  });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? messages : polish}>
      <ReviewQueue locale="pl" kind="recipe" />
    </NextIntlClientProvider>,
  );
  await screen.findByRole('group');
}

/** The draft under that name has the focus. It takes it once it is on the page, which is a moment after it is found there. */
const focused = (name: string) =>
  vi.waitFor(() => expect(screen.getByRole('group', { name })).toHaveFocus());

const draft = (current: number, visible: number) =>
  screen.getByRole('group', { name: `Draft ${current} of ${visible}` });
const button = (name: string) => screen.getByRole('button', { name });
const keysOn = () => userEvent.click(button(text.keys));

describe("the reviewer's queue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('names the buttons that go to the draft before and after', async () => {
    await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);

    expect(button(text.previous)).toBeDisabled();
    await userEvent.click(button(text.next));

    expect(draft(2, 2)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: text.fieldTitle })).toHaveValue('Jajecznica');
    expect(button(text.next)).toBeDisabled();
    // A step with a button leaves the focus on the button.
    expect(button(text.next)).toHaveFocus();
  });

  it("names a draft's allergens as the rest of the app does, in the reader's language", async () => {
    await renderQueue([recipe(FIRST, 'Owsianka', { allergens: ['dairy', 'nuts', 'lupin'] })], 'pl');

    // A code this version has no name for is shown as it is.
    expect(screen.getByText('Alergeny: Nabiał, Orzechy i lupin')).toBeInTheDocument();
  });

  it('says which language the reviewer writes in by its name', async () => {
    await renderQueue([recipe(FIRST, 'Owsianka')]);

    expect(screen.getByText('Your locale (Polish)')).toBeInTheDocument();
  });

  it('names every step for those who do not see where it stands', async () => {
    await renderQueue([recipe(FIRST, 'Owsianka')]);

    expect(screen.getByRole('textbox', { name: 'Step 2' })).toHaveValue('Podaj.');
  });

  describe('with the keys off, as they are until the reviewer turns them on', () => {
    it('a letter decides nothing, and no key is promised', async () => {
      const approve = vi.spyOn(reviewApi, 'approveRecipe');
      const reject = vi.spyOn(reviewApi, 'rejectRecipe');
      await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);

      draft(1, 2).focus();
      await userEvent.keyboard('arj');

      expect(approve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(draft(1, 2)).toBeInTheDocument();
      expect(button(text.keys)).toHaveAttribute('aria-pressed', 'false');
      expect(button(text.approve)).not.toHaveAttribute('aria-keyshortcuts');
      expect(screen.queryByText(/approves/)).not.toBeInTheDocument();
    });

    it('the first draft leaves the focus alone, and the one after a decision takes it', async () => {
      vi.spyOn(reviewApi, 'approveRecipe').mockResolvedValue(recipe(FIRST, 'Owsianka'));
      await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);
      expect(draft(1, 2)).not.toHaveFocus();

      await userEvent.click(button(text.approve));

      // The button that was pressed went with its draft: the focus is not lost with it.
      await focused('Draft 1 of 1');
      expect(screen.getByRole('textbox', { name: text.fieldTitle })).toHaveValue('Jajecznica');
    });
  });

  describe('with the keys on', () => {
    it('says what each key does and that a decision cannot be taken back', async () => {
      await renderQueue([recipe(FIRST, 'Owsianka')]);

      await keysOn();

      expect(button(text.keys)).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText(/A decision cannot be taken back here\./)).toHaveTextContent(
        'With the draft selected, not a field in it: A approves, R rejects, S saves, ← → or K J go to the draft before and after. Esc leaves a field.',
      );
      expect(button(text.approve)).toHaveAttribute('aria-keyshortcuts', 'A');
      expect(button(text.reject)).toHaveAttribute('aria-keyshortcuts', 'R');
      expect(button(text.save)).toHaveAttribute('aria-keyshortcuts', 'S');
      // Turning them on moved no focus.
      expect(button(text.keys)).toHaveFocus();
    });

    it('A approves the draft on show, and the next draft has the focus and the keys', async () => {
      const approve = vi
        .spyOn(reviewApi, 'approveRecipe')
        .mockResolvedValue(recipe(FIRST, 'Owsianka'));
      await renderQueue([
        recipe(FIRST, 'Owsianka'),
        recipe(SECOND, 'Jajecznica'),
        recipe(THIRD, 'Kanapka'),
      ]);
      await keysOn();

      draft(1, 3).focus();
      await userEvent.keyboard('a');
      await focused('Draft 1 of 2');
      await userEvent.keyboard('a');

      await focused('Draft 1 of 1');
      expect(approve.mock.calls.map(([, id]) => id)).toEqual([FIRST, SECOND]);
      expect(screen.getByRole('textbox', { name: text.fieldTitle })).toHaveValue('Kanapka');
    });

    it('R rejects with the reason that was typed', async () => {
      const reject = vi
        .spyOn(reviewApi, 'rejectRecipe')
        .mockResolvedValue(recipe(FIRST, 'Owsianka'));
      await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);
      await keysOn();

      await userEvent.type(
        screen.getByRole('textbox', { name: text.rejectReasonPlaceholder }),
        'Not a breakfast',
      );
      await userEvent.keyboard('{Escape}r');

      expect(reject).toHaveBeenCalledExactlyOnceWith('pl', FIRST, 'Not a breakfast');
      await focused('Draft 1 of 1');
    });

    it('J and K, and the arrows, go to the draft after and before, and stop at the ends', async () => {
      await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);
      await keysOn();
      const title = () => screen.getByRole('textbox', { name: text.fieldTitle });

      draft(1, 2).focus();
      await userEvent.keyboard('j');
      expect(draft(2, 2)).toHaveFocus();
      expect(title()).toHaveValue('Jajecznica');
      await userEvent.keyboard('j{ArrowRight}');
      expect(title()).toHaveValue('Jajecznica');

      await userEvent.keyboard('{ArrowLeft}');
      expect(draft(1, 2)).toHaveFocus();
      expect(title()).toHaveValue('Owsianka');
      await userEvent.keyboard('k');
      expect(title()).toHaveValue('Owsianka');
    });

    it('S saves what was typed, once: there is nothing to save after it', async () => {
      const patch = vi
        .spyOn(reviewApi, 'patchRecipeSlice')
        .mockResolvedValue(recipe(FIRST, 'Owsianka z jabłkiem'));
      await renderQueue([recipe(FIRST, 'Owsianka')]);
      await keysOn();

      await userEvent.type(screen.getByRole('textbox', { name: text.fieldTitle }), ' z jabłkiem');
      await userEvent.keyboard('{Escape}s');
      await screen.findByRole('button', { name: text.save });
      await userEvent.keyboard('s');

      expect(patch).toHaveBeenCalledExactlyOnceWith('pl', FIRST, {
        title: 'Owsianka z jabłkiem',
        description: undefined,
        steps: undefined,
      });
      expect(button(text.save)).toBeDisabled();
    });

    it('a letter typed into a field is a letter', async () => {
      const approve = vi.spyOn(reviewApi, 'approveRecipe');
      await renderQueue([recipe(FIRST, 'Owsianka')]);
      await keysOn();

      await userEvent.type(screen.getByRole('textbox', { name: text.fieldTitle }), ' a');

      expect(screen.getByRole('textbox', { name: text.fieldTitle })).toHaveValue('Owsianka a');
      expect(approve).not.toHaveBeenCalled();
    });

    it('are on for the next visit, and off again once turned off', async () => {
      await renderQueue([recipe(FIRST, 'Owsianka')]);
      await keysOn();
      cleanup();

      await renderQueue([recipe(FIRST, 'Owsianka')]);
      // The draft of a reviewer who wants the keys has the focus as it comes up.
      await focused('Draft 1 of 1');
      expect(button(text.keys)).toHaveAttribute('aria-pressed', 'true');

      await userEvent.click(button(text.keys));
      expect(button(text.keys)).toHaveAttribute('aria-pressed', 'false');
      expect(draft(1, 1)).toHaveAttribute('tabindex', '-1');
    });
  });

  it('does not approve text it could not save: the draft stays, with what went wrong', async () => {
    vi.spyOn(reviewApi, 'patchRecipeSlice').mockRejectedValue(
      new ApiClientError(503, 'UNAVAILABLE', 'down'),
    );
    const approve = vi.spyOn(reviewApi, 'approveRecipe');
    await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);

    await userEvent.type(screen.getByRole('textbox', { name: text.fieldTitle }), ' z jabłkiem');
    await userEvent.click(button(text.approve));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: text.fieldTitle })).toHaveValue(
      'Owsianka z jabłkiem',
    );
  });

  it('approves what was typed once it is saved', async () => {
    const patch = vi
      .spyOn(reviewApi, 'patchRecipeSlice')
      .mockResolvedValue(recipe(FIRST, 'Owsianka z jabłkiem'));
    const approve = vi
      .spyOn(reviewApi, 'approveRecipe')
      .mockResolvedValue(recipe(FIRST, 'Owsianka z jabłkiem'));
    await renderQueue([recipe(FIRST, 'Owsianka'), recipe(SECOND, 'Jajecznica')]);

    await userEvent.type(screen.getByRole('textbox', { name: text.fieldTitle }), ' z jabłkiem');
    await userEvent.click(button(text.approve));

    await vi.waitFor(() => expect(approve).toHaveBeenCalledExactlyOnceWith('pl', FIRST));
    expect(patch).toHaveBeenCalledExactlyOnceWith('pl', FIRST, {
      title: 'Owsianka z jabłkiem',
      description: undefined,
      steps: undefined,
    });
    expect(await screen.findByDisplayValue('Jajecznica')).toBeInTheDocument();
  });

  it('has nothing left to save once the text was saved', async () => {
    const patch = vi
      .spyOn(reviewApi, 'patchRecipeSlice')
      .mockResolvedValue(recipe(FIRST, 'Owsianka z jabłkiem'));
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
    let answer: (page: {
      items: RecipeReviewSlice[];
      total: number;
      page: number;
      pageSize: number;
    }) => void = () => undefined;
    list.mockResolvedValueOnce({
      items: [recipe(FIRST, 'Owsianka')],
      total: 2,
      page: 1,
      pageSize: 25,
    });
    list.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReviewQueue locale="pl" kind="recipe" />
      </NextIntlClientProvider>,
    );
    await screen.findByRole('group');

    await userEvent.click(button(text.approve));

    // The next page is on its way: the queue is not said to be empty meanwhile.
    expect(await screen.findByText(text.queueLoading)).toBeInTheDocument();
    expect(screen.queryByText(text.queueEmpty)).not.toBeInTheDocument();
    answer({ items: [recipe(SECOND, 'Jajecznica')], total: 1, page: 1, pageSize: 25 });
    await focused('Draft 1 of 1');
  });

  it('says nothing is left once the last page is done', async () => {
    vi.spyOn(reviewApi, 'approveRecipe').mockResolvedValue(recipe(FIRST, 'Owsianka'));
    const list = vi.spyOn(reviewApi, 'listRecipeSlices');
    list.mockResolvedValueOnce({
      items: [recipe(FIRST, 'Owsianka')],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReviewQueue locale="pl" kind="recipe" />
      </NextIntlClientProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: text.approve }));

    expect(await screen.findByText(text.queueEmpty)).toBeInTheDocument();
  });

  it('says what the language decided about a draft before', async () => {
    await renderQueue([
      recipe(FIRST, 'Owsianka', { alreadyReviewed: true, alreadyReviewedAction: 'REJECT' }),
    ]);

    expect(screen.getByText('Rejected for this language before')).toBeInTheDocument();
  });

  it('has the same keys for the names of ingredients', async () => {
    const name: IngredientNameReviewSlice = {
      id: FIRST,
      ingredientSlug: 'beef-tenderloin',
      rawDescription: 'Beef, loin, tenderloin roast, separable lean only',
      locale: 'pl',
      name: 'Polędwica wołowa',
      nameSource: 'Beef tenderloin',
      storageHint: null,
      storageHintSource: null,
      batchId: 'batch-1',
      modelUsed: null,
      status: 'PENDING',
      alreadyReviewed: false,
      alreadyReviewedAction: null,
    };
    vi.spyOn(reviewApi, 'listIngredientNameSlices').mockResolvedValue({
      items: [name],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    const approve = vi.spyOn(reviewApi, 'approveIngredientName').mockResolvedValue(name);
    localStorage.setItem('diet-app.review.keys', 'on');
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ReviewQueue locale="pl" kind="ingredient-name" />
      </NextIntlClientProvider>,
    );
    const region = await screen.findByRole('group', { name: 'Draft 1 of 1' });
    expect(within(region).getByRole('textbox', { name: text.fieldName })).toHaveValue(
      'Polędwica wołowa',
    );

    await userEvent.keyboard('a');

    expect(approve).toHaveBeenCalledExactlyOnceWith('pl', FIRST);
  });
});
