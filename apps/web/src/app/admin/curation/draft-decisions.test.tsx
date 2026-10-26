// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocaleReview } from '@diet-app/shared';
import { adminApi, type IngredientNameDraft, type RecipeDraft } from '@/lib/admin-api';
import messages from '../../../../messages/en.json';
import { IngredientPanel } from './ingredient-panel';
import { RecipeDraftRow } from './recipe-draft-row';

const texts = messages.admin.curation;

/** English approved and Polish rejected: the decisions each language has now. */
const DECIDED: LocaleReview[] = [
  {
    locale: 'en',
    action: 'APPROVE',
    byRole: 'ADMIN',
    reviewedByLabel: 'Admin',
    reason: null,
    reviewedAt: '2026-10-26T10:00:00.000Z',
  },
  {
    locale: 'pl',
    action: 'REJECT',
    byRole: 'REVIEWER',
    reviewedByLabel: 'Ola',
    reason: 'Literówka',
    reviewedAt: '2026-10-26T10:05:00.000Z',
  },
];

const aRecipeDraft = (): RecipeDraft =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'greek-yogurt-with-almonds-honey',
    titles: { en: 'Greek yogurt with almonds & honey', pl: 'Jogurt grecki z migdałami i miodem' },
    descriptions: { en: 'A quick snack.', pl: 'Szybka przekąska.' },
    steps: { en: ['Mix.'], pl: ['Wymieszaj.'] },
    locales: ['en', 'pl'],
    servings: 1,
    mealTypes: ['snack'],
    dietTags: [],
    prepMinutes: 5,
    cookMinutes: 0,
    difficulty: 'easy',
    cuisine: null,
    complexity: 'simple',
    caloriesPerServing: 320,
    proteinPerServing: 18,
    fatPerServing: 16,
    carbsPerServing: 24,
    allergens: [],
    ingredients: [{ slug: 'greek-yogurt', quantity: 170, unit: 'g' }],
    status: 'PENDING',
    source: 'AI',
    batchId: 'batch',
    modelUsed: null,
    generatorPrompt: null,
    generationSpec: null,
    provenanceUrl: null,
    provenanceLicense: null,
    shippedAt: null,
    createdAt: '2026-10-26T09:00:00.000Z',
    updatedAt: '2026-10-26T10:05:00.000Z',
    localeReviews: DECIDED,
    pastReviews: [],
  }) as RecipeDraft;

const anIngredientNameDraft = (): IngredientNameDraft => ({
  id: '22222222-2222-4222-8222-222222222222',
  ingredientId: '33333333-3333-4333-8333-333333333333',
  ingredientSlug: 'nuts-almonds-whole-raw',
  rawDescription: 'Nuts, almonds, whole, raw',
  suggestions: { name: { en: 'Almonds', pl: 'Migdały' } },
  locales: ['en', 'pl'],
  status: 'PENDING',
  source: 'AI',
  batchId: 'batch',
  modelUsed: null,
  generatorPrompt: null,
  shippedAt: null,
  createdAt: '2026-10-26T09:00:00.000Z',
  updatedAt: '2026-10-26T10:05:00.000Z',
  localeReviews: DECIDED,
  pastReviews: [],
});

const shown = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );

/** The approve and reject buttons of a language, as the row names them. */
const decision = (action: string, locale: string) =>
  screen.getByRole('button', { name: `${action} · ${locale}` });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the decisions of a draft in the administrator’s panel', () => {
  it('cannot be taken again for a recipe in a language that has it, and can be changed', async () => {
    shown(<RecipeDraftRow draft={aRecipeDraft()} onChanged={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Greek yogurt with almonds/ }));

    expect(decision(texts.approve, 'en')).toBeDisabled();
    expect(decision(texts.reject, 'en')).toBeEnabled();
    expect(decision(texts.approve, 'pl')).toBeEnabled();
    expect(decision(texts.reject, 'pl')).toBeDisabled();
  });

  it('cannot be taken again for the name of an ingredient either', async () => {
    vi.spyOn(adminApi, 'ingredientNamerStatus').mockResolvedValue(null as never);
    vi.spyOn(adminApi, 'listIngredientNameDrafts').mockResolvedValue({
      items: [anIngredientNameDraft()],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    } as never);

    shown(<IngredientPanel />);

    expect(await screen.findByRole('button', { name: `${texts.approve} · en` })).toBeDisabled();
    expect(decision(texts.reject, 'en')).toBeEnabled();
    expect(decision(texts.approve, 'pl')).toBeEnabled();
    expect(decision(texts.reject, 'pl')).toBeDisabled();
  });
});

describe('the drafts of names in the administrator’s panel', () => {
  it('are rejected all at once, with one name and one reason, so that the next run writes them again', async () => {
    const shownDrafts = [
      { ...anIngredientNameDraft(), localeReviews: [] },
      {
        ...anIngredientNameDraft(),
        id: '44444444-4444-4444-8444-444444444444',
        ingredientSlug: 'fish-salmon-atlantic-farm-raised-raw',
        localeReviews: [],
      },
    ];
    vi.spyOn(adminApi, 'ingredientNamerStatus').mockResolvedValue(null as never);
    vi.spyOn(adminApi, 'listIngredientNameDrafts').mockResolvedValue({
      items: shownDrafts,
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
    } as never);
    const reject = vi
      .spyOn(adminApi, 'rejectIngredientNameDrafts')
      .mockResolvedValue({ rejected: shownDrafts.map((draft) => draft.id), skipped: [] });
    vi.spyOn(window, 'prompt')
      .mockReturnValueOnce('Admin')
      .mockReturnValueOnce('Write them again.');

    shown(<IngredientPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reject the 2 shown' }));

    expect(reject).toHaveBeenCalledExactlyOnceWith(
      shownDrafts.map((draft) => draft.id),
      'Admin',
      'Write them again.',
    );
    expect(await screen.findByText('2 rejected.')).toBeInTheDocument();
  });
});
