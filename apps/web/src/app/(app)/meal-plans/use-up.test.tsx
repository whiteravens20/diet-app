// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiGenerationMeta, UseUpSuggestion, UseUpSuggestions } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { UseUp } from './use-up';

const texts = messages.mealPlans.useUp;
const PLAN = '11111111-1111-4111-8111-111111111111';

const aSuggestion = (
  mealType: UseUpSuggestion['mealType'],
  over: Partial<UseUpSuggestion> = {},
): UseUpSuggestion => ({
  plannedMealId: `meal-${mealType}`,
  date: '2026-01-06',
  mealType,
  from: { id: 'recipe-stew', title: 'Chickpea stew' },
  to: { id: 'recipe-chicken', title: 'Chicken with rice' },
  servings: 1,
  before: { calories: 671, protein: 26, fat: 18, carbs: 96 },
  after: { calories: 600, protein: 45, fat: 14, carbs: 70 },
  takes: [{ ingredientId: 'chicken', name: 'Chicken breast', unit: 'g', amount: 150, left: 200 }],
  packs: {
    before: { bought: 1500, used: 650, wasted: 2 },
    after: { bought: 1500, used: 800, wasted: 2 },
  },
  reason: null,
  pick: null,
  ...over,
});
const found = (
  suggestions: UseUpSuggestion[],
  aiMeta: UseUpSuggestions['aiMeta'] = null,
): UseUpSuggestions => ({ revision: 7, suggestions, aiMeta });
const answered: AiGenerationMeta = {
  provider: 'ollama',
  model: 'test-model',
  failoverChain: [],
  usedDeterministicFallback: false,
  fallbackReason: null,
  reason: null,
};

/** The panel, with the API answering `plain` when the engine is asked and `weighed` when a model is. */
function shown(
  plain: UseUpSuggestions,
  { weighed, aiEnabled = true }: { weighed?: UseUpSuggestions; aiEnabled?: boolean } = {},
) {
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation((path: string, body?: unknown) =>
      Promise.resolve(
        (path === '/meal-plans/swap-meal'
          ? { plan: {}, rebalance: null }
          : (body as { weigh?: boolean }).weigh
            ? weighed
            : plain) as never,
      ),
    );
  const onSwapped = vi.fn();
  const onStale = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient()}>
        <UseUp
          planId={PLAN}
          aiEnabled={aiEnabled}
          aiOffNote="why-off"
          mealName={(type) => type}
          busy={false}
          onSwapped={onSwapped}
          onStale={onStale}
        />
        <p id="why-off">AI is off.</p>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { post, onSwapped, onStale };
}
const ask = () => userEvent.click(screen.getByRole('button', { name: texts.ask }));

describe('what would use up the packs a plan opens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is asked for, and nothing is shown before', async () => {
    const { post } = shown(found([aSuggestion('lunch')]));
    expect(screen.queryByRole('list')).toBeNull();

    await ask();

    expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/use-up`, { weigh: false });
    expect(await screen.findByRole('list')).toBeInTheDocument();
  });

  it('names the meal, the recipe that would take its place, what that takes of the pack and what the meal would hold', async () => {
    shown(found([aSuggestion('lunch')]));
    await ask();

    const swap = within(await screen.findByRole('listitem'));
    expect(swap.getByText(/Tue, Jan 6 · lunch:/)).toBeInTheDocument();
    expect(swap.getByText('Chicken with rice').parentElement).toHaveTextContent(
      'Chicken with rice in place of Chickpea stew',
    );
    expect(
      swap.getByText('takes 150 g more of Chicken breast, and 200 g of its pack would be left'),
    ).toBeInTheDocument();
    expect(swap.getByText('The meal: 671 → 600 kcal · protein 26 → 45 g')).toBeInTheDocument();
  });

  it('makes the swap that is taken as any swap is made, on the plan as it was read, and tells the page what came of it', async () => {
    const { post, onSwapped } = shown(found([aSuggestion('lunch'), aSuggestion('dinner')]));
    await ask();

    await userEvent.click(
      within((await screen.findAllByRole('listitem'))[1]!).getByRole('button', {
        name: messages.mealPlans.offerTake,
      }),
    );

    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith('/meal-plans/swap-meal', {
        planId: PLAN,
        plannedMealId: 'meal-dinner',
        recipeId: 'recipe-chicken',
        revision: 7,
        strategy: 'random',
        allowOffDiet: false,
      }),
    );
    await vi.waitFor(() => expect(onSwapped).toHaveBeenCalledWith({ plan: {}, rebalance: null }));
    // The suggestions were for the plan as it was: they are gone with it.
    expect(screen.queryByRole('list')).toBeNull();
  });

  it("comes back in a model's order with its sentences when one is asked, and hands the note of its pick back with the swap", async () => {
    const lunch = aSuggestion('lunch');
    const dinner = aSuggestion('dinner');
    const { post } = shown(found([lunch, dinner]), {
      weighed: found(
        [{ ...dinner, reason: 'Keeps the stew for lunch.', pick: 'a-note' }, lunch],
        answered,
      ),
    });
    await ask();
    await screen.findByRole('list');

    await userEvent.click(screen.getByRole('button', { name: messages.weigh.ask }));

    expect(
      await screen.findByText('A model says of this: “Keeps the stew for lunch.”'),
    ).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/use-up`, { weigh: true });
    expect(screen.getByRole('status')).toHaveTextContent(messages.weigh.weighed);
    await userEvent.click(
      within(screen.getAllByRole('listitem')[0]!).getByRole('button', {
        name: messages.mealPlans.offerTake,
      }),
    );
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/meal-plans/swap-meal',
        expect.objectContaining({ plannedMealId: 'meal-dinner', pick: 'a-note' }),
      ),
    );
  });

  it('says so when nothing would use them up, and offers no model to weigh nothing', async () => {
    shown(found([]));
    await ask();

    expect(await screen.findByText(texts.none)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.weigh.ask })).toBeNull();
  });

  it('keeps the button that asks a model in its place on an account with AI off, disabled, with the reason', async () => {
    shown(found([aSuggestion('lunch')]), { aiEnabled: false });
    await ask();
    await screen.findByRole('list');

    const weigh = screen.getByRole('button', { name: messages.weigh.ask });
    expect(weigh).toBeDisabled();
    expect(weigh).toHaveAccessibleDescription('AI is off.');
  });

  it('says so when the plan had changed under a suggestion, and tells the page to read the plan anew', async () => {
    const { post, onStale, onSwapped } = shown(found([aSuggestion('lunch')]));
    await ask();
    await screen.findByRole('list');
    post.mockRejectedValueOnce(new ApiClientError(409, 'PLAN_CHANGED', 'The plan changed.'));

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerTake }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.PLAN_CHANGED);
    expect(onStale).toHaveBeenCalledOnce();
    expect(onSwapped).not.toHaveBeenCalled();
  });

  it('says so when the swaps cannot be looked for', async () => {
    const { post } = shown(found([]));
    post.mockRejectedValueOnce(new ApiClientError(0, 'NETWORK', 'Cannot reach the server.'));

    await ask();

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
  });
});
