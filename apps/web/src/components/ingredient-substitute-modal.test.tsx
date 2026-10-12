// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlannedIngredient, SwapPreview } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import polish from '../../messages/pl.json';
import { IngredientSubstituteModal } from './ingredient-substitute-modal';

const taken = (ingredientId: string, name: string, quantity: number): PlannedIngredient => ({ ingredientId, name, quantity, unit: 'g', display: { quantity, unit: 'g' }, note: null });
const rice = taken('11111111-1111-4111-8111-111111111111', 'White rice', 120);
const chickpeas = taken('22222222-2222-4222-8222-222222222222', 'Chickpeas', 265);
const meal = { id: '33333333-3333-4333-8333-333333333333', recipe: { id: '44444444-4444-4444-8444-444444444444', title: 'Chicken with rice' }, ingredients: [rice] };

/** Chickpeas for the rice of the meal: the same energy, and nothing in the way. */
const aPreview = (over: Partial<SwapPreview> = {}): SwapPreview => ({
  before: { calories: 900, protein: 65, fat: 22, carbs: 110 },
  after: { calories: 902, protein: 66, fat: 24, carbs: 108 },
  calorieDelta: 2,
  macroDelta: { protein: 1, fat: 2, carbs: -2 },
  from: rice,
  to: chickpeas,
  sizing: 'energy',
  merged: false,
  violations: [],
  moved: [],
  valid: true,
  ...over,
});

/** The modal with the rice picked and chickpeas chosen in its place, the API answering `preview`. */
async function substituting(preview: SwapPreview, locale: 'en' | 'pl' = 'en') {
  const texts = locale === 'en' ? messages : polish;
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve((path === '/users/me' ? { aiMode: 'none' } : path.startsWith('/ingredients') ? [{ id: chickpeas.ingredientId, name: chickpeas.name }] : []) as never),
  );
  const post = vi.spyOn(api, 'post').mockImplementation((path: string) => Promise.resolve((path.endsWith('/preview') ? preview : { plan: {}, rebalance: null, aiMeta: null }) as never));
  const onApplied = vi.fn();
  render(
    <NextIntlClientProvider locale={locale} messages={texts}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <IngredientSubstituteModal meal={meal} planId="55555555-5555-4555-8555-555555555555" onClose={() => undefined} onApplied={onApplied} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: /White rice/ }));
  await userEvent.type(screen.getByPlaceholderText(texts.pickers.ingredientSearch), 'chick');
  await userEvent.click(await screen.findByRole('button', { name: 'Chickpeas' }));
  const delta = (await screen.findByText(texts.swap.stepDelta)).closest('section')!;
  return { post, onApplied, delta, applyButton: () => screen.getByRole('button', { name: texts.swap.apply }) };
}

describe('the substitution of an ingredient, before it is made', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says in words how much of the substitute comes for how much of the ingredient, in the amounts of the meal', async () => {
    const { applyButton } = await substituting(aPreview());

    expect(await screen.findByText('265 g Chickpeas in place of 120 g White rice: as much as holds the same energy.')).toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
  });

  it('names the ingredient a substitute is looked for', async () => {
    await substituting(aPreview());

    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === '2. Replace White rice with…')).toBeInTheDocument();
  });

  it.each(['energy', 'capped', 'mass'] as const)('says it in Polish with both names and both amounts as they stand (%s)', async (sizing) => {
    const { delta } = await substituting(aPreview({ sizing }), 'pl');

    const sentence = [...delta.querySelectorAll('p')].find((line) => line.textContent!.includes('White rice'))!.textContent!;
    for (const part of ['White rice', '120 g', 'Chickpeas', '265 g']) expect(sentence).toContain(part);
    expect(sentence).not.toMatch(/[{}]|swap\.sizing/);
  });

  it.each([
    ['capped', '265 g Chickpeas in place of 120 g White rice: three times as much is the most a substitute is given, so the meal holds less energy.'],
    ['mass', '265 g Chickpeas in place of 120 g White rice: the same amount, as one of the two holds no energy to go by.'],
  ] as const)('says so when the amount was decided another way (%s)', async (sizing, sentence) => {
    await substituting(aPreview({ sizing }));

    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it('says that the recipe has the substitute already', async () => {
    await substituting(aPreview({ merged: true }));

    expect(await screen.findByText('The recipe has Chickpeas already: its amount grows, and no second line is written.')).toBeInTheDocument();
  });

  it('warns when a serving moves by more than a tenth, and makes the substitution once the user accepts that', async () => {
    const { post, applyButton } = await substituting(aPreview({ moved: ['protein', 'carbs'] }));

    expect(await screen.findByText('This changes what a serving holds by more than a tenth: protein, carbohydrate.')).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: messages.swap.acceptChange }));
    await userEvent.click(applyButton());

    const applied = post.mock.calls.find(([path]) => String(path).endsWith('/apply'))!;
    expect(applied[1]).toMatchObject({ fromIngredientId: rice.ingredientId, toIngredientId: chickpeas.ingredientId, acceptChange: true });
  });

  it('sends nothing accepted where nothing moved', async () => {
    const { post, applyButton, onApplied } = await substituting(aPreview());

    await userEvent.click(applyButton());

    expect(post.mock.calls.find(([path]) => String(path).endsWith('/apply'))![1]).toMatchObject({ acceptChange: false });
    await vi.waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('says why a substitution may not be made, and does not offer it', async () => {
    const { applyButton } = await substituting(aPreview({ valid: false, violations: ['allergen', 'off_diet'] }));

    const reasons = await screen.findByRole('alert');
    expect(reasons.textContent).toContain(messages.swap.violation.allergen);
    expect(reasons.textContent).toContain(messages.swap.violation.off_diet);
    expect(applyButton()).toBeDisabled();
  });

  it('offers what the catalogue itself suggests for the ingredient, without a search, and previews it when it is chosen', async () => {
    vi.spyOn(api, 'get').mockImplementation((path: string) =>
      Promise.resolve(
        (path === '/users/me' ? { aiMode: 'none' } : path.endsWith('/substitutes') ? [{ fromIngredientId: rice.ingredientId, to: { id: chickpeas.ingredientId, name: 'Chickpeas' }, moved: [] }] : []) as never,
      ),
    );
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPreview() as never);
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <IngredientSubstituteModal meal={meal} planId="55555555-5555-4555-8555-555555555555" onClose={() => undefined} onApplied={() => undefined} />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /White rice/ }));

    expect(await screen.findByText(messages.swap.catalogueSuggests, { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Chickpeas' })[0]!);

    expect(await screen.findByText('265 g Chickpeas in place of 120 g White rice: as much as holds the same energy.')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/meal-plans/swap-ingredient/preview', expect.objectContaining({ toIngredientId: chickpeas.ingredientId }));
  });

  it('words a refusal of the API by its code', async () => {
    const { post, applyButton } = await substituting(aPreview());
    post.mockRejectedValueOnce(new ApiClientError(422, 'SUBSTITUTION_MOVES_NUTRITION', 'the text of the API'));

    await userEvent.click(applyButton());

    expect(await screen.findByText(messages.errors.SUBSTITUTION_MOVES_NUTRITION)).toBeInTheDocument();
  });
});
