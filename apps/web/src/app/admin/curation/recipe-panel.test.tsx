// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftRunnerState } from '@diet-app/shared';
import { adminApi, type RecipeRunnerState, type ShipConfigDto } from '@/lib/admin-api';
import messages from '../../../../messages/en.json';
import { RecipePanel } from './recipe-panel';

const text = messages.admin.curation;

const IDLE: DraftRunnerState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  processed: 0,
  total: 0,
  failed: 0,
  written: 0,
  provider: null,
  model: null,
  batchId: null,
  error: null,
  skipped: 0,
  note: null,
  configured: true,
};

const RUN_IDLE: RecipeRunnerState = {
  ...IDLE,
  target: null,
  complexityCounts: { simple: 0, medium: 0, complex: 0 },
  mixDrift: false,
  lastRejectReason: null,
  lastRejectKey: null,
  lastRejectHead: null,
};

beforeEach(() => {
  vi.spyOn(adminApi, 'recipeGeneratorStatus').mockResolvedValue(RUN_IDLE);
  vi.spyOn(adminApi, 'listRecipeDrafts').mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  vi.spyOn(adminApi, 'shipConfig').mockResolvedValue({
    modes: { local: { available: true }, bundle: { available: true } },
    instanceData: {
      writable: true,
      recipeFiles: 0,
      recipes: 0,
      names: 0,
      version: null,
      notRestored: 0,
    },
    approvedCounts: { recipe: 0, ingredientName: 0 },
  } as ShipConfigDto);
  vi.spyOn(adminApi, 'translationsStatus').mockResolvedValue(IDLE);
  vi.spyOn(adminApi, 'importRejections').mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const shown = async () => {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RecipePanel />
    </NextIntlClientProvider>,
  );
  const generate = screen.getByRole('button', { name: text.generateRecipes });
  await vi.waitFor(() => expect(generate).toBeEnabled());
  return {
    generate,
    diets: within(screen.getByRole('group', { name: text.runDiets })),
    meals: within(screen.getByRole('group', { name: text.runMeals })),
    fill: screen.getByRole('checkbox', { name: text.fillCoverage }),
  };
};

describe('a run of recipe drafts started from the panel', () => {
  it('writes for the diets, meals, cuisine and way of cooking the administrator chose', async () => {
    const start = vi.spyOn(adminApi, 'startRecipeGenerator').mockResolvedValue(RUN_IDLE);
    const { generate, diets, meals } = await shown();

    await userEvent.click(diets.getByRole('checkbox', { name: 'Keto' }));
    await userEvent.click(diets.getByRole('checkbox', { name: 'Vegan' }));
    await userEvent.click(meals.getByRole('checkbox', { name: 'Breakfast' }));
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: text.runCuisine }),
      'Middle Eastern',
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: text.runCookingMethod }),
      'Pan-fried',
    );
    await userEvent.click(generate);

    expect(start).toHaveBeenCalledExactlyOnceWith({
      count: 5,
      catalogueScope: 'curated',
      dietTags: ['keto', 'vegan'],
      mealTypes: ['breakfast'],
      // In words, which the run reads as the cuisine it tags its drafts with.
      cuisine: 'middle eastern',
      cookingMethod: 'pan_fried',
    });
  });

  it('leaves the diet, the meal, the cuisine and the way of cooking to the model when none is chosen', async () => {
    const start = vi.spyOn(adminApi, 'startRecipeGenerator').mockResolvedValue(RUN_IDLE);
    const { generate } = await shown();

    await userEvent.click(generate);

    expect(start).toHaveBeenCalledExactlyOnceWith({ count: 5, catalogueScope: 'curated' });
  });

  it('fills what the catalogue lacks only while no diet or meal is chosen, since it chooses the pair itself', async () => {
    const start = vi.spyOn(adminApi, 'startRecipeGenerator').mockResolvedValue(RUN_IDLE);
    const { generate, diets, meals, fill } = await shown();

    await userEvent.click(meals.getByRole('checkbox', { name: 'Breakfast' }));
    expect(fill).toBeDisabled();
    await userEvent.click(meals.getByRole('checkbox', { name: 'Breakfast' }));
    expect(fill).toBeEnabled();

    await userEvent.click(fill);
    expect(diets.getByRole('checkbox', { name: 'Keto' })).toBeDisabled();
    expect(meals.getByRole('checkbox', { name: 'Breakfast' })).toBeDisabled();
    await userEvent.click(generate);

    expect(start).toHaveBeenCalledExactlyOnceWith({
      count: 5,
      catalogueScope: 'curated',
      fillCoverage: true,
    });
  });
});
