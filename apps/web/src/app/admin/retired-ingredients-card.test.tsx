// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient, RetiredIngredient } from '@diet-app/shared';
import { adminApi } from '@/lib/admin-api';
import messages from '../../../messages/en.json';
import { RetiredIngredientsCard } from './retired-ingredients-card';

const texts = messages.admin.retired;

const ALMONDS_RAW: RetiredIngredient = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'nuts-almonds-whole-raw',
  name: 'Nuts, almonds, whole, raw',
  retiredAt: '2026-10-16T10:37:06.000Z',
  uses: {
    libraryRecipes: 0,
    ownRecipes: 1,
    drafts: 1,
    pantryRows: 0,
    profiles: 0,
    shoppingRows: 0,
  },
  usedIn: ['Greek yogurt with almonds & honey'],
};

const ALMONDS = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Almonds',
} as Ingredient;

const shown = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RetiredIngredientsCard />
    </NextIntlClientProvider>,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the retired ingredients the instance still uses, in the panel', () => {
  it('are not shown at all while there are none', async () => {
    const asked = vi.spyOn(adminApi, 'retiredIngredients').mockResolvedValue([]);

    const { container } = shown();

    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('say what uses each, and which recipes and drafts may name it in their text', async () => {
    vi.spyOn(adminApi, 'retiredIngredients').mockResolvedValue([ALMONDS_RAW]);

    shown();

    expect(await screen.findByText(ALMONDS_RAW.name)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Used by: library recipes (0), users’ recipes (1), drafts (1), pantry rows (0), profiles (0), shopping-list rows (0).',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Their text may name it: Greek yogurt with almonds & honey'),
    ).toBeInTheDocument();
  });

  it('replace one by an ingredient of the catalogue found by name, once that is confirmed, and say what moved', async () => {
    vi.spyOn(adminApi, 'retiredIngredients')
      .mockResolvedValueOnce([ALMONDS_RAW])
      .mockResolvedValueOnce([]);
    const search = vi.spyOn(adminApi, 'searchIngredients').mockResolvedValue([ALMONDS]);
    const replace = vi.spyOn(adminApi, 'replaceIngredient').mockResolvedValue({
      recipeLines: 1,
      draftLines: 1,
      pantryRows: 0,
      preferences: 0,
      shoppingRows: 0,
      deleted: true,
      recomputedRecipes: 1,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    shown();

    await userEvent.click(await screen.findByRole('button', { name: texts.replace }));
    await userEvent.type(
      screen.getByRole('textbox', { name: `An ingredient to replace ${ALMONDS_RAW.name} with` }),
      'almo',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Almonds' }));

    expect(search).toHaveBeenLastCalledWith('almo');
    expect(confirm).toHaveBeenCalledWith(
      `Replace “${ALMONDS_RAW.name}” with “Almonds” wherever it is used? The text of recipes does not change.`,
    );
    expect(replace).toHaveBeenCalledExactlyOnceWith(ALMONDS_RAW.id, ALMONDS.id);
    expect(
      await screen.findByText(
        `“${ALMONDS_RAW.name}” replaced with “Almonds”: recipe lines (1), draft lines (1), pantry rows (0), profiles (0), shopping-list rows (0).`,
      ),
    ).toBeInTheDocument();
  });

  it('replace nothing when the replacement is not confirmed', async () => {
    vi.spyOn(adminApi, 'retiredIngredients').mockResolvedValue([ALMONDS_RAW]);
    vi.spyOn(adminApi, 'searchIngredients').mockResolvedValue([ALMONDS]);
    const replace = vi.spyOn(adminApi, 'replaceIngredient');
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    shown();

    await userEvent.click(await screen.findByRole('button', { name: texts.replace }));
    await userEvent.type(screen.getByRole('textbox'), 'almo');
    await userEvent.click(await screen.findByRole('button', { name: 'Almonds' }));

    expect(replace).not.toHaveBeenCalled();
  });
});
