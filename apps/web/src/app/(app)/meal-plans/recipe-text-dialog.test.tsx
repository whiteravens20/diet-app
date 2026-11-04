// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { RecipeTextDialog } from './recipe-text-dialog';

const SWAPPED = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Bowl (with chickpeas)',
  description: 'A bowl for one.',
  steps: ['Cook chickpeas.', 'Serve.'],
  origin: 'swap',
} as Recipe;

function shown() {
  const get = vi.spyOn(api, 'get').mockResolvedValue(SWAPPED);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RecipeTextDialog recipeId={SWAPPED.id} onClose={onClose} onSaved={onSaved} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { get, onClose, onSaved, window: within(screen.getByRole('dialog')) };
}

describe('the window the words of a recipe a swap made are corrected in', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts from what the recipe says, and writes the words alone into it', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ ...SWAPPED, title: 'Chickpea bowl' });
    const { get, onSaved, window } = shown();

    const title = await window.findByRole('textbox', { name: messages.ownRecipe.fieldTitle });
    expect(get).toHaveBeenCalledWith(`/recipes/${SWAPPED.id}`);
    expect(window.getByText(messages.mealPlans.rewordIntro)).toBeInTheDocument();
    await userEvent.clear(title);
    await userEvent.type(title, 'Chickpea bowl');
    const first = window.getByRole('textbox', { name: 'Step 1' });
    await userEvent.clear(first);
    await userEvent.type(first, 'Warm the chickpeas.');
    await userEvent.click(window.getByRole('button', { name: messages.common.save }));

    expect(put).toHaveBeenCalledWith(`/recipes/${SWAPPED.id}/text`, {
      title: 'Chickpea bowl',
      description: 'A bowl for one.',
      steps: ['Warm the chickpeas.', 'Serve.'],
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('says a refusal in words and stays open', async () => {
    vi.spyOn(api, 'put').mockRejectedValue(
      new ApiClientError(400, 'RECIPE_INVALID', 'Breaks a rule.'),
    );
    const { onSaved, window } = shown();

    await userEvent.click(await window.findByRole('button', { name: messages.common.save }));

    expect(await window.findByRole('alert')).toHaveTextContent(messages.errors.RECIPE_INVALID);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('can be closed without a change', async () => {
    const put = vi.spyOn(api, 'put');
    const { onClose, window } = shown();

    await userEvent.click(await window.findByRole('button', { name: messages.common.cancel }));

    expect(onClose).toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
